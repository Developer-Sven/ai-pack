# Components V2, Modals, Selects, Buttons (discord.js 14.27 / @discordjs/builders 1.14.1)

Alle Builder werden in v14 aus `discord.js` re-exportiert. (v15: nicht mehr — siehe `discord-v15-migration`.)

## Components V2 (Nachrichten)
Aktivierung pro Nachricht mit `flags: MessageFlags.IsComponentsV2` (`1 << 15`), ab discord.js 14.19.

| Regel | Wert (Discord-Changelog 2025-04-29 + Component Reference) |
|---|---|
| Komponenten gesamt | **40** (verschachtelte mitgezählt); **kein** Top-Level-Limit mehr (früher 10), Container unbegrenzt |
| Text | 4000 Zeichen über alle TextDisplays zusammen |
| Verboten mit V2 | `content`, `embeds`, `poll`, `stickers` |
| Anhänge | `files` erlaubt, aber **nur sichtbar**, wenn eine File-/MediaGallery-/Thumbnail-Komponente `attachment://<name>` referenziert |
| Flag | einmal V2 → die Nachricht bleibt V2 (auch beim `edit`) |

Bausteine (v14-Methoden, verifiziert):
- `ContainerBuilder` — `setAccentColor`, `setSpoiler`, `addTextDisplayComponents`, `addSectionComponents`,
  `addSeparatorComponents`, `addMediaGalleryComponents`, `addFileComponents`, `addActionRowComponents`, `spliceComponents`
- `TextDisplayBuilder().setContent('## Titel\n**Markdown**')` · `-# klein` für Footer
- `SectionBuilder` — 1–3 TextDisplays + **genau ein** Accessory: `setThumbnailAccessory(ThumbnailBuilder)`
  oder `setButtonAccessory(ButtonBuilder)` (**nicht** `setPrimaryButtonAccessory` — das ist builders v2/v15)
- `SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small|Large)`
- `MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(url).setDescription(alt))` (1–10 Items)
- `FileBuilder().setURL('attachment://ticket-123.html')` · `ThumbnailBuilder().setURL(url).setDescription(alt)`

```js
const file = new AttachmentBuilder(buf, { name: 'report.html' });
await channel.send({
  components: [buildContainer({ title: 'Report', description: '…', attachments: ['report.html'] })],
  files: [file],
  flags: MessageFlags.IsComponentsV2,
  allowedMentions: { parse: [] },                  // User-Text in TextDisplay pingt sonst
});
await interaction.reply({ components: [c], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
```

## Modals (Label-basiert)
Top-Level in Modals: **Label** (max. 5) und **TextDisplay**. Jedes Eingabefeld sitzt in einem Label.
`ActionRow + TextInput` und `TextInputBuilder#setLabel` sind **deprecated** (builders ≥ 1.12).

| Feature | ab discord.js | Label-Setter | Submit-Getter (`i.fields.*`) |
|---|---|---|---|
| TextInput | – | `setTextInputComponent` | `getTextInputValue(id)` |
| String/User/Role/Mentionable/Channel-Select | 14.23 | `setStringSelectMenuComponent` … `setChannelSelectMenuComponent` | `getStringSelectValues`, `getSelectedUsers/Members/Roles/Channels/Mentionables(id, required)` |
| TextDisplay (Top-Level) | 14.23 | `modal.addTextDisplayComponents` | – |
| FileUpload (0–10 Dateien) | 14.24 | `setFileUploadComponent` | `getUploadedFiles(id, required)` → Collection<Attachment> |
| RadioGroup / CheckboxGroup / Checkbox | 14.26 | `setRadioGroupComponent` / `setCheckboxGroupComponent` / `setCheckboxComponent` | `getRadioGroup(id, required)` / `getCheckboxGroup(id)` / `getCheckbox(id)` |

```js
const { ModalBuilder, TextInputStyle } = require('discord.js');
const modal = new ModalBuilder().setCustomId('report::submit').setTitle('Meldung')
  .addTextDisplayComponents((t) => t.setContent('Bitte sachlich bleiben.'))
  .addLabelComponents(
    (l) => l.setLabel('Wer?').setUserSelectMenuComponent((s) => s.setCustomId('user').setMaxValues(1)),
    (l) => l.setLabel('Grund').setDescription('max. 1000 Zeichen')
      .setTextInputComponent((t) => t.setCustomId('reason').setStyle(TextInputStyle.Paragraph).setMaxLength(1000)),
    (l) => l.setLabel('Kategorie').setRadioGroupComponent((r) => r.setCustomId('cat')
      .setOptions({ label: 'Spam', value: 'spam' }, { label: 'Beleidigung', value: 'insult' })),
    (l) => l.setLabel('Beweise').setFileUploadComponent((f) => f.setCustomId('proof').setMaxValues(3).setRequired(false)),
    (l) => l.setLabel('Anonym melden?').setCheckboxComponent((c) => c.setCustomId('anon')),
  );
await i.showModal(modal);

// Submit (i.isModalSubmit() && i.customId === 'report::submit'):
const target = i.fields.getSelectedUsers('user', true).first();
const reason = i.fields.getTextInputValue('reason').trim();
const cat = i.fields.getRadioGroup('cat', true);                   // gegen Whitelist prüfen!
const files = i.fields.getUploadedFiles('proof') ?? new Map();
const anon = i.fields.getCheckbox('anon');
```
- `showModal()` muss die **erste** Antwort sein (kein `deferReply`/`reply` davor); aus einem Modal-Submit
  kein weiteres Modal → Button als Brücke.
- Modal-Werte sind **User-Input**: Länge, Whitelist (Radio/Select-Values), Snowflakes prüfen.
- Uploads: `attachment.size`, `contentType`, Endung prüfen; nie ungeprüft ausführen/einbetten/weiterleiten.
  Die API kennt seit 2026-08-05 `file_types`-Filter für FileUpload — builders 1.14.1 hat dafür noch
  keinen Setter; serverseitige Prüfung ist ohnehin Pflicht.

## Select Menus (Nachrichten)
```js
new StringSelectMenuBuilder().setCustomId('x').setPlaceholder('Wähle').setMinValues(1).setMaxValues(3)
  .addOptions({ label: 'A', value: 'a', emoji: '✅' });              // max 25 Optionen
new UserSelectMenuBuilder().setCustomId('u').setMaxValues(5);
new RoleSelectMenuBuilder().setCustomId('r').setDefaultRoles('111…');
new ChannelSelectMenuBuilder().setCustomId('c').setChannelTypes(ChannelType.GuildText);
new MentionableSelectMenuBuilder().setCustomId('m');
// Listener: isStringSelectMenu() → i.values · isUserSelectMenu() → i.users · isRoleSelectMenu() → i.roles
//           isChannelSelectMenu() → i.channels · isAnySelectMenu() für alle (v15: isSelectMenu())
```
`SelectMenuBuilder`/`isSelectMenu()` (v14-Alias für String) sind deprecated → `StringSelectMenu*`.

## Buttons
```js
new ButtonBuilder().setCustomId('mod::warn::123').setLabel('Warnen').setStyle(ButtonStyle.Danger);
new ButtonBuilder().setStyle(ButtonStyle.Link).setURL('https://…').setLabel('Web');
new ButtonBuilder().setStyle(ButtonStyle.Premium).setSKUId('123…');  // nur SKU + Style
```
Max. 5 pro ActionRow. Custom-ID ≤ 100 Zeichen, Format `modul::aktion::id`, **nie** Autorisierung daraus
ableiten. `sendPremiumRequired()` ist deprecated → Premium-Button.

## Interaction-Timing
| Aktion | Frist |
|---|---|
| Erste Antwort (`reply`, `deferReply`, `deferUpdate`, `showModal`, `update`) | 3 s |
| Folgeaktionen (`editReply`, `followUp`) mit Token | 15 min |
| Buttons alter Nachrichten | unbegrenzt klickbar → Zustand immer aus dem Store prüfen |

`reply({ withResponse: true })` liefert `InteractionCallbackResponse` → Nachricht unter
`response.resource.message` (ersetzt deprecated `fetchReply: true`).
