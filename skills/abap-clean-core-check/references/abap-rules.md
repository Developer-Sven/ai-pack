# ABAP Cloud / RAP — always-on rules

System-specific, opinionated rules for the RAP programming model, clean core, and ABAP Cloud development. Applies to **BTP ABAP Environment** and **S/4HANA on-prem in the ABAP Cloud development model**.

These rules are **self-contained** for the RAP and ABAP Cloud context. They do not depend on, and do not load, the companion `clean-abap` plugin's rule set at runtime. Install the `clean-abap` plugin separately if you want its universal Clean ABAP rules and skills (`/clean-abap:review`, `/clean-abap:refactor`).

Where BTP and S/4HANA on-prem behave differently, the rule calls it out explicitly.

When generating or reviewing code that touches CDS, BDEF, behavior implementation classes, or any object that runs in ABAP Cloud language scope, apply every rule below.

---

## Tooling — official SAP ADT MCP first, ARC-1 as fallback

Two MCP servers may be connected at the same time. They overlap only partly, and the split is deliberate:

- **`abap-adt`** — the official SAP server shipped in `SAPSE.adt-vscode`. **Authoritative for anything that changes the system**, and for ATC. Its tools take a `destination` parameter; list them with `mcp__abap-adt__abap_list_destinations`.
- **`arc-1`** — community server. **Authoritative for reading and searching**, which the official server does not offer at all. Bound to a single system — no destination selector. It can also create, write, and activate when the operator has enabled write scope (`SAP_ALLOW_WRITES` and the related flags), which makes it a genuine fallback for the write path too.

**Selection rule: for each capability, call the primary tool. Fall back only when the primary is absent from the session or returns a hard error** (tool not found, "user was logged off", unauthorized). Do not silently switch servers mid-task — say which one produced the result when it matters.

**Detecting whether `arc-1` writes are enabled — do this before planning around them.** The gating is visible in the tool schema: when write scope is off, `SAPWrite` and `SAPActivate` are **not exposed at all**, and the mutating actions are **absent from the remaining tools' `action` enums**. A read-only instance offers `SAPManage` with `features`/`probe`/`cache_stats` and no `create_package`; `SAPTransport` with `list`/`get`/`check` and no `create`/`release`; `SAPGit` with no `push`/`commit`. Check what you actually have before promising a write, and never call an action that is not in the enum you were given.

**A write can still be refused after all that.** `SAP_ALLOWED_PACKAGES` (default `$TMP`) is enforced fail-closed on every mutation, including activation, against the object's *real* package. A refusal on a `Z*`/`Y*` object with writes enabled is the allowlist, not a broken connection — report it as a configuration limit rather than retrying.

| Capability | Primary | Fallback |
|---|---|---|
| Read object source | `arc-1` `SAPRead` | ask the user to paste from ADT |
| Search repository, list a package | `arc-1` `SAPSearch`, `SAPRead type=DEVC` | ask the user |
| Dependencies, where-used, CDS impact | `arc-1` `SAPContext`, `SAPNavigate` | ask the user |
| **Run ATC** | `abap-adt` `abap_atc_run` + `abap_atc_get_result` | `arc-1` `SAPDiagnose action="atc"` |
| ATC quick fixes | `abap-adt` `abap_atc_execute_deterministic_quickfixes`, `abap_atc_apply_ai_fix` + `abap_atc_get_ai_fix_result` | `arc-1` `SAPDiagnose action="quickfix"` → `"apply_quickfix"` |
| List ATC check variants | `arc-1` `SAPDiagnose action="atc_variants"` | ask the user for the variant name |
| Run ABAP Unit | `abap-adt` `abap_run_unit_tests` | `arc-1` `SAPDiagnose action="unittest"` |
| Syntax-check existing or draft source | `arc-1` `SAPDiagnose action="syntax"` | `abap-adt` `abap_creation-run_validation` (creation payloads only) |
| Create objects / write source | `abap-adt` `abap_creation-create_object` (after `abap_creation-run_validation`) | `arc-1` `SAPWrite`, **when write scope is enabled** — see the pre-write note below |
| Create a package | `abap-adt` `abap_creation-create_object` | `arc-1` `SAPManage action="create_package"` |
| Generate a RAP service | `abap-adt` `abap_generators-*` | hand-crafted skeletons written through whichever write path is available |
| Activate objects | `abap-adt` `abap_activate_objects` | `arc-1` `SAPActivate`, when write scope is enabled; confirm with `SAPRead type=INACTIVE_OBJECTS` that nothing is left inactive |
| Transports | `abap-adt` `abap_transport-get` / `-create` / `-unifiedDifference` | `arc-1` `SAPTransport` — `list`/`get`/`check` always, `create`/`release`/`reassign` when transport writes are enabled |
| Release an object as an API (set C0–C4) | `arc-1` `SAPManage action="set_api_state"` | do it in ADT |
| OData / service-binding info | `abap-adt` `abap_business_services-fetch_services`, `-fetch_service_information` | `arc-1` `SAPRead type=SRVB` |
| API release-contract state (C0–C4) | `arc-1` `SAPRead type=API_STATE` | ask the user to check in ADT |
| Local lint / pretty-print | `arc-1` `SAPLint` | none |

**This table is an observation, not a contract.** It reflects `SAPSE.adt-vscode` **1.1.1** (verified 2026-08) and a contemporaneous `arc-1`. Both servers gain tools over time. If the live tool list disagrees with this table — a capability listed here as missing turns out to be present, or an action is gone — **trust the live list**, use the primary you actually have, and say that the table is out of date. Never skip a primary because this document says it lacks something.

**Writing through `arc-1` — what it checks for you, and what it does not.** `arc-1` `SAPWrite` runs two pre-write layers, and only one of them stops a bad write:

- **abaplint** (`SAP_LINT_BEFORE_WRITE`, default **on**) — **blocks** the write on lint errors, for `PROG`, `CLAS`, `INTF`, `INCL`, `DDLS`. `FUNC` is deliberately excluded, so a function module gets no lint gate.
- **SAP's server-side syntax check** (`SAP_CHECK_BEFORE_WRITE`, default **off**) — compiles the proposed source without writing it, but is **advisory by design**: findings are appended to the write result and the source is written anyway. That is deliberate, not a bug. In a multi-object sequence, intermediate writes legitimately fail to compile until their dependencies land — a BDEF written before its behavior pool exists is the normal case.

**So activation is the real gate, not the write.** A successful `SAPWrite` means "lint passed", never "this compiles". After writing through `arc-1`: (1) read the object back with `SAPRead` and confirm it matches what you intended; (2) run `SAPActivate`; (3) check `SAPRead type=INACTIVE_OBJECTS` is clear. Step 3 is what catches a half-activated stack, and it is the step that actually matters. When writing a single object with no pending dependencies, `SAPDiagnose action="syntax"` with `source` is still worth running first — it is a true dry run and turns a compile error into a pre-write finding rather than an activation failure.

If **neither** server is connected, every skill still works on **pasted** source. Never invent source, ATC findings, object names, or release states.

---

## RULE: released-apis-only
**Why**: ABAP Cloud language scope only allows objects with a public C1 release contract. Using an unreleased class, interface, function module, or CDS entity will fail syntax check, will not activate, and breaks the moment SAP changes the unreleased object.
**Do**:
```abap
" Verify the release contract before use — use a released API
DATA(uuid) = cl_system_uuid=>create_uuid_x16_static( ).

DATA(messages) = NEW cl_ble_log_message_collector( ).
```
**Avoid**:
```abap
" Unreleased internal class — works today, breaks tomorrow, fails ATC in Cloud
DATA(uuid) = cl_uuid_factory=>create_system_uuid( )->create_uuid_x16( ).

" Unreleased internal helper — no C1 contract
CALL FUNCTION 'GUID_CREATE' IMPORTING ev_guid_16 = DATA(guid).
```
**System scope**: BTP — hard error at activation. S/4HANA on-prem Cloud development — ATC error in the ABAP Cloud development variant.
**ATC**: SAP standard ATC — *Usage of released APIs* (variant `ABAP_CLOUD_DEVELOPMENT_DEFAULT`)

---

## RULE: no-direct-select-on-sap-owned-tables
**Why**: SAP-owned database tables (e.g. `VBAK`, `MARA`, `BKPF`) are not part of the public API contract — their structure, semantics, and even existence are not guaranteed across releases. Released CDS view entities are the supported access path.
**Do**:
```abap
SELECT FROM I_SalesOrder
       FIELDS SalesOrder, OverallSalesStatus, TotalNetAmount
       WHERE SoldToParty = @customer_id
       INTO TABLE @DATA(orders).
```
**Avoid**:
```abap
" Direct SELECT on a SAP-owned table — not released for use in ABAP Cloud
SELECT FROM vbak
       FIELDS vbeln, gbstk, netwr
       WHERE kunnr = @customer_id
       INTO TABLE @DATA(orders).
```
**System scope**: BTP — hard error at activation. S/4HANA on-prem Cloud development — ATC error.
**ATC**: SAP standard ATC — *Released Database Tables and Views* (variant `ABAP_CLOUD_DEVELOPMENT_DEFAULT`)

---

## RULE: abap-cloud-language-scope-only
**Why**: ABAP Cloud language scope forbids constructs that bind to the old SAP GUI stack, the classic non-Cloud database access model, or unreleased runtime services. Constructs like classic dynpro, `CALL TRANSACTION`, `SUBMIT`, `FORM`/`PERFORM`, classic batch input, and unreleased function modules either fail syntax check or fail activation.
**Do**:
```abap
" Modern Cloud-compatible constructs only
CLASS zcl_order_processor DEFINITION
  PUBLIC FINAL
  CREATE PRIVATE.

  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
ENDCLASS.

CLASS zcl_order_processor IMPLEMENTATION.
  METHOD if_oo_adt_classrun~main.
    out->write( |Hello from ABAP Cloud| ).
  ENDMETHOD.
ENDCLASS.
```
**Avoid**:
```abap
" Classic dynpro — forbidden in ABAP Cloud
CALL SCREEN 100.

" Classic SUBMIT — forbidden in ABAP Cloud
SUBMIT zreport WITH p_kunnr = customer_id AND RETURN.

" FORM/PERFORM — forbidden in ABAP Cloud
PERFORM process_order USING order_id.

FORM process_order USING p_order TYPE vbeln.
ENDFORM.
```
**System scope**: BTP — these constructs do not exist. S/4HANA on-prem Cloud development — ATC error; the same source file may compile in Classic ABAP scope, which is why scope must be set per package.
**ATC**: SAP standard ATC — *ABAP Language Version: ABAP for Cloud Development* (variant `ABAP_CLOUD_DEVELOPMENT_DEFAULT`)

---

## RULE: no-modification-of-sap-standard
**Why**: Direct modification of SAP standard objects breaks clean core, blocks upgrades, and is impossible to deploy in BTP. All extension must go through released extension points — Cloud BAdIs, key user extensibility, custom CDS views consuming released SAP entities, or RAP extensions where exposed.
**Do**:
```abap
" Implement a released Cloud BAdI for an extension point SAP exposes
CLASS zcl_check_order_priority DEFINITION
  PUBLIC FINAL
  CREATE PUBLIC
  FOR BADI BADI_SALES_ORDER_PRIORITY.   " released Cloud BAdI

  PUBLIC SECTION.
    INTERFACES if_sales_order_priority.
ENDCLASS.
```
**Avoid**:
```abap
" Modifying a SAP standard class via Forbidden modification
" Or copying SAP source into Z* — both break the upgrade contract.
CLASS cl_sales_order_processor DEFINITION
  INHERITING FROM /sap/cl_sales_order_processor   " SAP class — not for inheritance
  FINAL.
  ...
ENDCLASS.
```
**System scope**: BTP — modification is technically impossible. S/4HANA on-prem Cloud development — ATC blocks modifications of SAP-owned objects.
**ATC**: SAP standard ATC — *Modification check* / *Use of released enhancement options only*

---

## RULE: managed-vs-unmanaged-decision-criteria
**Why**: Choosing the wrong RAP implementation type costs weeks of refactoring later. `managed` is correct when the BO owns its persistence; `unmanaged` is only correct when persistence already exists in legacy code that cannot be migrated.
**Do**:
```abap
" New BO on a new Z* table -> managed
managed implementation in class zbp_r_salesorder unique;
strict ( 2 );

define behavior for ZR_SalesOrder alias SalesOrder
persistent table zsalesorder
lock master
authorization master ( instance )
etag master LastChangedAt
{
  field ( numbering : managed, readonly ) SalesOrderUUID;
  field ( readonly ) CreatedAt, CreatedBy, LastChangedAt, LastChangedBy;
  field ( mandatory ) Customer;

  create;
  update;
  delete;
}
```
**Avoid**:
```abap
" Choosing unmanaged just because the developer is uncomfortable with managed.
" Unmanaged is only correct when an existing non-RAP persistence layer (BAPI,
" legacy update task) must be reused and migration is out of scope.
unmanaged implementation in class zbp_r_salesorder unique;

define behavior for ZR_SalesOrder alias SalesOrder
implementation in class zbp_r_salesorder unique
{
  create;
  update;
  delete;
}
```
**Decision rule**: New BO on customer tables → **managed**. Wrapping a legacy BAPI / update module you cannot rewrite → **unmanaged**. There is no third option.
**System scope**: Identical on BTP and S/4HANA on-prem.

---

## RULE: semantic-key-alongside-technical-uuid
**Why**: A UUID primary key is correct for technical stability and concurrency, but UUIDs are unreadable to humans and unusable as a business reference. Every BO needs both: UUID as the technical key, plus a human-readable, externally meaningful semantic key (e.g. `SalesOrder`, `MaterialNumber`).
**Do**:
```abap
" Database table
@EndUserText.label : 'Sales Order'
define table zsalesorder {
  key client          : abap.clnt not null;
  key salesorder_uuid : sysuuid_x16 not null;     " technical key
      salesorder      : zsales_order_no;          " semantic key, unique
      customer        : kunnr;
      ...
}

" CDS interface entity exposes both
define view entity ZI_SalesOrder
  as select from zsalesorder as SalesOrder
{
  key SalesOrderUUID,
      @ObjectModel.text.element: [ 'CustomerName' ]
      SalesOrder,
      Customer,
      ...
}

" BDEF: UUID is the BO key, but the semantic key is mandatory and unique
field ( numbering : managed, readonly ) SalesOrderUUID;
field ( mandatory ) SalesOrder;
```
**Avoid**:
```abap
" UUID-only — operationally unusable. A user cannot quote it on a support ticket.
@EndUserText.label : 'Sales Order'
define table zsalesorder {
  key client          : abap.clnt not null;
  key salesorder_uuid : sysuuid_x16 not null;
      customer        : kunnr;
      ...
}
```
**System scope**: Identical on BTP and S/4HANA on-prem.

---

## RULE: draft-handling-with-correct-lock-strategy
**Why**: Drafts are required when an editable BO needs multi-step input, server-side validation while typing, or any UI that allows incremental save. Enabling drafts without `lock master` produces concurrent edits with silent data loss; enabling them without a draft table prevents activation.
**Do**:
```abap
managed implementation in class zbp_r_salesorder unique;
strict ( 2 );
with draft;

define behavior for ZR_SalesOrder alias SalesOrder
persistent table zsalesorder
draft table zsalesorder_d
lock master total etag LastChangedAt
authorization master ( instance )
etag master LastChangedAt
{
  field ( numbering : managed, readonly ) SalesOrderUUID;
  field ( mandatory ) Customer;

  create;
  update;
  delete;

  draft action Edit;
  draft action Activate optimized;
  draft action Discard;
  draft action Resume;
  draft determine action Prepare;
}
```
**Avoid**:
```abap
" Draft declared on behaviour but no draft table — does not activate.
managed implementation in class zbp_r_salesorder unique;
with draft;

define behavior for ZR_SalesOrder alias SalesOrder
persistent table zsalesorder
" no draft table
lock master                       " no 'total' modifier => lock contention bugs
{
  create;
  update;
  delete;
  " missing draft Edit/Activate/Discard/Resume/Prepare actions
}
```
**System scope**: Identical on BTP and S/4HANA on-prem.

---

## RULE: separate-determinations-validations-and-side-effects
**Why**: Mixing default calculation, input rejection, and UI-refresh triggering into one behavior method makes the BO impossible to reason about: validations end up writing data, determinations end up vetoing input, and side effects fire on the wrong events. Each has a single, distinct purpose.
**Do**:
```abap
define behavior for ZR_SalesOrder alias SalesOrder
{
  " Determination: compute or default fields. Never reject.
  determination calculateGrossAmount on save { create; field Quantity, NetPrice; }

  " Validation: check input. Never write. Returns failed-state on rejection.
  validation validateCustomerExists on save { create; field Customer; }
  validation validateQuantityPositive on save { create; field Quantity; }

  " Side effect: tell the UI which fields need refreshing after a change.
  side effects {
    field Quantity affects field GrossAmount;
    field Customer affects field CustomerName;
    action Block affects field OverallStatus;
  }
}
```
**Avoid**:
```abap
" A validation that also writes default values. The framework treats this as
" a validation only — the writes can be silently discarded or fire twice.
validation validate_and_set_defaults on save { create; field Customer, Quantity; }

" A determination that decides whether to reject. Determinations cannot fail
" the operation cleanly — use a validation.
determination reject_blocked_customer on save { create; field Customer; }
```
**System scope**: Identical on BTP and S/4HANA on-prem.

---

## RULE: action-design-instance-static-factory
**Why**: Actions are the only RAP construct for non-CRUD behavior. Choosing the wrong kind makes UIs awkward and confuses the framework: instance actions need an entity in context, static actions run without one, factory actions create new instances. Mixing them up makes the action either uncallable or unusable.
**Do**:
```abap
define behavior for ZR_SalesOrder alias SalesOrder
{
  " Instance action — operates on a specific order
  action Block result [1] $self;
  action Unblock result [1] $self;

  " Static action — runs without a selected instance
  static action ImportFromFile parameter zr_file_import result [0..*] $self;

  " Factory action — creates new instances from an existing context
  factory action CopyFrom [1];
}
```
**Avoid**:
```abap
define behavior for ZR_SalesOrder alias SalesOrder
{
  " A "create from template" implemented as a regular instance action.
  " The Fiori UI cannot navigate to the new instance because the action
  " is not declared as a factory action.
  action CopyFromTemplate result [1] $self;

  " A "system-wide cleanup" declared as instance action — every caller has
  " to pick an arbitrary instance to invoke it.
  action CleanupOldDrafts result [0..0];   " should be static
}
```
**System scope**: Identical on BTP and S/4HANA on-prem.

---

## RULE: feature-control-static-or-dynamic-where-each-belongs
**Why**: Feature control determines whether a field is read-only, whether an action is enabled, and whether an entity is creatable. Static feature control is evaluated at design time and visible in tooling; dynamic feature control runs in the behavior pool and can react to instance state. Using dynamic where static would do bloats the behavior pool with trivial checks; using static where dynamic is needed gives the UI wrong information.
**Do**:
```abap
define behavior for ZR_SalesOrder alias SalesOrder
{
  " Static: the rule does not depend on instance state.
  field ( readonly ) SalesOrderUUID, CreatedAt, CreatedBy, LastChangedAt, LastChangedBy;
  field ( mandatory ) Customer;

  " Dynamic: depends on the current OverallStatus of the instance.
  action ( features : instance ) Block result [1] $self;
  action ( features : instance ) Unblock result [1] $self;

  field ( features : instance ) Customer;   " e.g. read-only once order is released
}

" In the behavior pool:
METHOD get_instance_features.
  READ ENTITIES OF zr_salesorder IN LOCAL MODE
    ENTITY SalesOrder
       FIELDS ( OverallStatus )
       WITH CORRESPONDING #( keys )
    RESULT DATA(orders).

  result = VALUE #( FOR order IN orders
                    ( %tky                = order-%tky
                      %action-Block       = COND #( WHEN order-OverallStatus = status_open
                                                    THEN if_abap_behv=>fc-o-enabled
                                                    ELSE if_abap_behv=>fc-o-disabled )
                      %action-Unblock     = COND #( WHEN order-OverallStatus = status_blocked
                                                    THEN if_abap_behv=>fc-o-enabled
                                                    ELSE if_abap_behv=>fc-o-disabled )
                      %field-Customer     = COND #( WHEN order-OverallStatus = status_open
                                                    THEN if_abap_behv=>fc-f-read_only
                                                    ELSE if_abap_behv=>fc-f-mandatory ) ) ).
ENDMETHOD.
```
**Avoid**:
```abap
" Dynamic feature control for a rule that does not depend on instance state —
" UUID is ALWAYS read-only. This runs the behavior pool on every UI refresh
" for no reason.
field ( features : instance ) SalesOrderUUID;

" Static read-only for a field whose editability depends on status —
" the UI will permanently show the field as read-only even when it should be editable.
field ( readonly ) Customer;
```
**System scope**: Identical on BTP and S/4HANA on-prem.

---

## RULE: cds-layering-interface-then-projection-then-consumption
**Why**: A CDS view that mixes data shaping, business logic, and UI annotations cannot be reused, refactored, or tested. The interface/projection/consumption split is non-negotiable: it lets the same data feed an OData service, an analytical query, and another internal consumer without duplicating SQL.
**Do**:
```abap
" Layer 1 — Interface entity. Pure data shape. Stable contract. Reused everywhere.
@AbapCatalog.viewEnhancementCategory: [#NONE]
@AccessControl.authorizationCheck: #CHECK
@EndUserText.label: 'Sales Order — Interface'
@Metadata.ignorePropagatedAnnotations: true
@VDM.viewType: #BASIC
define view entity ZI_SalesOrder
  as select from zsalesorder as SalesOrder
  composition [0..*] of ZI_SalesOrderItem as _Items
  association [1]    to I_Customer        as _Customer on $projection.Customer = _Customer.Customer
{
  key SalesOrderUUID,
      SalesOrder,
      Customer,
      OverallStatus,
      _Customer,
      _Items
}

" Layer 2 — Projection. Structural reshape for one consumer. No business logic.
@AccessControl.authorizationCheck: #CHECK
@EndUserText.label: 'Sales Order — Projection'
@Metadata.allowExtensions: true
define root view entity ZR_SalesOrder
  provider contract transactional_query
  as projection on ZI_SalesOrder
{
  key SalesOrderUUID,
      SalesOrder,
      Customer,
      OverallStatus,
      _Customer,
      _Items : redirected to composition child ZR_SalesOrderItem
}

" Layer 3 — Consumption. UI/OData annotations live here, nowhere else.
@AccessControl.authorizationCheck: #CHECK
@EndUserText.label: 'Sales Order — Consumption'
@Metadata.allowExtensions: true
@UI.headerInfo: { typeName: 'Sales Order', typeNamePlural: 'Sales Orders' }
define root view entity ZC_SalesOrder
  provider contract transactional_query
  as projection on ZR_SalesOrder
{
  key SalesOrderUUID,
      @UI.lineItem: [{ position: 10 }]
      SalesOrder,
      ...
}
```
**Avoid**:
```abap
" One view doing everything: SQL, business logic, UI annotations.
" Cannot be reused, cannot be safely refactored, every consumer pays for every annotation.
@AccessControl.authorizationCheck: #CHECK
@UI.headerInfo: { typeName: 'Sales Order' }
define view entity ZC_SalesOrder_EVERYTHING
  as select from vbak as SalesOrder       " also: direct table SELECT — see released-apis-only
  inner join vbap as Item on SalesOrder.vbeln = Item.vbeln
{
  key SalesOrder.vbeln                                                      as SalesOrderUUID,
      SalesOrder.kunnr                                                      as Customer,
      case when SalesOrder.gbstk = 'C' then 'X' else '' end                 as IsClosed,   " logic in interface
      @UI.lineItem: [{ position: 10 }]                                                       " UI in interface
      SalesOrder.netwr                                                      as NetAmount
}
```
**System scope**: Identical on BTP and S/4HANA on-prem.

---

## RULE: interface-entity-required-annotations
**Why**: Interface entities are the long-term contract for every downstream consumer. Missing `@AccessControl.authorizationCheck` opens an authorization hole; missing `@AbapCatalog` flags produce subtle filter and key-handling bugs at runtime; missing `@VDM.viewType` makes the entity invisible to SAP's own tooling.
**Do**:
```abap
@AbapCatalog.viewEnhancementCategory: [#NONE]
@AbapCatalog.compiler.compareFilter: true
@AbapCatalog.preserveKey: true
@AccessControl.authorizationCheck: #CHECK
@EndUserText.label: 'Sales Order — Interface'
@Metadata.ignorePropagatedAnnotations: true
@VDM.viewType: #BASIC
define view entity ZI_SalesOrder
  as select from zsalesorder as SalesOrder
{
  key SalesOrderUUID,
      SalesOrder,
      Customer,
      OverallStatus
}
```
**Avoid**:
```abap
" Missing authorization check — every caller bypasses authority by default.
" Missing @AbapCatalog flags — filter and key behaviour is whatever the
" current compiler default happens to be. Missing label — tooling shows raw name.
define view entity ZI_SalesOrder
  as select from zsalesorder as SalesOrder
{
  key SalesOrderUUID,
      SalesOrder,
      Customer
}
```
**System scope**: Identical on BTP and S/4HANA on-prem. `@AbapCatalog.sqlViewName` is **not** used on view entities — it belongs to legacy DDL views (`define view`), which are forbidden in ABAP Cloud. Always use `define view entity`.
**ATC**: SAP standard ATC — *CDS: Mandatory annotations*

---

## RULE: projection-views-contain-no-business-logic
**Why**: A projection view's job is to expose a tailored shape of an interface view to one consumer (a RAP service, an OData service, an analytical query). The moment a projection adds a case expression, a join, or a calculated field, it stops being a projection and becomes a hidden second interface — invisible to other consumers and impossible to evolve.
**Do**:
```abap
" Pure structural mapping. Field selection, aliases, redirected associations only.
@AccessControl.authorizationCheck: #CHECK
define root view entity ZR_SalesOrder
  provider contract transactional_query
  as projection on ZI_SalesOrder
{
  key SalesOrderUUID,
      SalesOrder,
      Customer,
      OverallStatus,
      GrossAmount,
      Currency,
      _Items : redirected to composition child ZR_SalesOrderItem,
      _Customer
}
```
**Avoid**:
```abap
" Joins, case expressions, computed fields, currency conversion — none of this
" belongs in a projection. Move it to the interface layer or a dedicated calculation view.
@AccessControl.authorizationCheck: #CHECK
define root view entity ZR_SalesOrder
  provider contract transactional_query
  as projection on ZI_SalesOrder
  inner join I_Customer as Customer
    on $projection.Customer = Customer.Customer       " join in projection
{
  key SalesOrderUUID,
      SalesOrder,
      $projection.Customer,
      case when $projection.OverallStatus = 'C'        " logic in projection
           then 'X' else '' end as IsClosed,
      currency_conversion(                              " calculation in projection
        amount => $projection.GrossAmount,
        source_currency => $projection.Currency,
        target_currency => cast( 'EUR' as abap.cuky ) ) as GrossAmountEUR
}
```
**System scope**: Identical on BTP and S/4HANA on-prem.

---

## RULE: composition-for-children-association-for-references
**Why**: `composition` declares a parent-owns-child relationship — the lifecycle, locking, draft, and authorization of the child follow the root. `association` declares a non-owning reference. Using association where composition is needed breaks draft and lock handling silently; using composition where association is needed creates phantom ownership of data the BO does not own.
**Do**:
```abap
define view entity ZI_SalesOrder
  as select from zsalesorder as SalesOrder
  composition [0..*] of ZI_SalesOrderItem as _Items          " owned children
  association [1]    to I_Customer        as _Customer       " reference to another BO
                       on $projection.Customer = _Customer.Customer
{
  key SalesOrderUUID,
      SalesOrder,
      Customer,
      _Items,
      _Customer
}

" In the BDEF: declare the composition child relationship
define behavior for ZI_SalesOrder alias SalesOrder
{
  association _Items { create; with draft; }
}
```
**Avoid**:
```abap
" Items modelled as association — items will not be locked with the order,
" will not be part of the draft, will not respect parent authorization.
define view entity ZI_SalesOrder
  as select from zsalesorder as SalesOrder
  association [0..*] to ZI_SalesOrderItem as _Items
                       on $projection.SalesOrderUUID = _Items.SalesOrderUUID
{
  key SalesOrderUUID,
      _Items
}

" Customer modelled as composition — implies SalesOrder owns Customer,
" which is wrong and breaks downstream when another BO also "owns" the Customer.
define view entity ZI_SalesOrder
  as select from zsalesorder as SalesOrder
  composition [1] of I_Customer as _Customer
{
  key SalesOrderUUID,
      _Customer
}
```
**System scope**: Identical on BTP and S/4HANA on-prem.

---

## RULE: every-behavior-class-has-abap-unit-with-cds-test-doubles
**Why**: A RAP behavior implementation that has no test cannot be safely changed, and the framework will not catch logic errors in determinations and validations — only syntax errors. ABAP Unit tests must live in the same include as the implementation, must use the CDS test double framework to isolate from live data, and must never assume any specific row exists in the database.
**Do**:
```abap
" Local test class in the same include as the behavior pool
CLASS ltc_validate_customer DEFINITION FINAL FOR TESTING
  DURATION SHORT
  RISK LEVEL HARMLESS.

  PRIVATE SECTION.
    CLASS-DATA cds_test_environment TYPE REF TO if_cds_test_environment.
    CLASS-METHODS class_setup.
    CLASS-METHODS class_teardown.

    METHODS setup.
    METHODS teardown.

    METHODS reject_unknown_customer FOR TESTING.
    METHODS accept_known_customer   FOR TESTING.
ENDCLASS.

CLASS ltc_validate_customer IMPLEMENTATION.

  METHOD class_setup.
    cds_test_environment = cl_cds_test_environment=>create(
      i_for_entity = 'ZI_SalesOrder'
      i_dependency_list = VALUE #( ( name = 'I_Customer' type = 'CDS_VIEW' ) ) ).
  ENDMETHOD.

  METHOD class_teardown.
    cds_test_environment->destroy( ).
  ENDMETHOD.

  METHOD setup.
    cds_test_environment->clear_doubles( ).
  ENDMETHOD.

  METHOD teardown.
    ROLLBACK ENTITIES.
  ENDMETHOD.

  METHOD reject_unknown_customer.
    " given — no customers in the test double
    cds_test_environment->insert_test_data( VALUE i_customer( ( customer = '1000' ) ) ).

    " when
    MODIFY ENTITIES OF zr_salesorder
      ENTITY SalesOrder
         CREATE FIELDS ( SalesOrder Customer )
           WITH VALUE #( ( %cid     = 'C1'
                           SalesOrder = '4711'
                           Customer = '9999' ) )       " unknown
      MAPPED   DATA(mapped)
      FAILED   DATA(failed)
      REPORTED DATA(reported).

    " then
    cl_abap_unit_assert=>assert_not_initial( failed-salesorder ).
    cl_abap_unit_assert=>assert_not_initial( reported-salesorder ).
  ENDMETHOD.

  METHOD accept_known_customer.
    cds_test_environment->insert_test_data( VALUE i_customer( ( customer = '1000' ) ) ).

    MODIFY ENTITIES OF zr_salesorder
      ENTITY SalesOrder
         CREATE FIELDS ( SalesOrder Customer )
           WITH VALUE #( ( %cid     = 'C1'
                           SalesOrder = '4712'
                           Customer = '1000' ) )
      MAPPED   DATA(mapped)
      FAILED   DATA(failed)
      REPORTED DATA(reported).

    cl_abap_unit_assert=>assert_initial( failed ).
  ENDMETHOD.

ENDCLASS.
```
**Avoid**:
```abap
" No test class at all — behavior changes have no safety net.

" Or: a test class that hits the live database directly, depending on the
" presence of customer '1000' in the test system. Breaks the moment the
" test system is refreshed. Cannot run in CI/CD against a clean tenant.
METHOD reject_unknown_customer.
  SELECT SINGLE FROM kna1 FIELDS kunnr WHERE kunnr = '1000' INTO @DATA(exists).
  cl_abap_unit_assert=>assert_not_initial( exists ).
  ...
ENDMETHOD.
```
**System scope**: Identical on BTP and S/4HANA on-prem. The CDS test double framework (`cl_cds_test_environment`) is available on both.
