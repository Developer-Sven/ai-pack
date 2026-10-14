# py-cord (Python) — kompakt

Für Python-Bots (`py-cord 2`). Architektur-Prinzipien aus `discordbots` gelten sinngemäß:
Cogs statt `modules/<name>/index.js`, Store-Zugriff über eine eigene Schicht, **jede Interaction
serverseitig prüfen**. Allgemeine Python-Konventionen: Skills `python-patterns` / `python-modern-stack`,
Review: Agent `python-reviewer`.

## Version (PyPI, 2026-09)
- **py-cord 2.8.1** (2026-07-25); Python **3.10–3.14** (`requires_python >=3.10,<3.15`); aiohttp ≥ 3.13.2.
- 2.7.0 (2025-12-24): Components V2 via **`discord.ui.DesignerView` / `DesignerModal`**, Selects/TextDisplay/
  FileUpload in Modals, Soundboard, Voice-Gateway v8; Python 3.8/3.9 entfernt.
- 2.8.0 (2026-05-18): `RadioGroup`, `CheckboxGroup`, `Checkbox` in Modals; **DAVE** für Voice-Senden;
  Python 3.14; Guild-Ownership-APIs entfernt; `suppress=` → `suppress_embeds=`;
  `discord.VoiceClient` → `discord.voice.VoiceClient` (deprecated Alias).
- Install: `pip install "py-cord==2.8.1"` · Voice: `"py-cord[voice]"` (PyNaCl + davey) · Speed: `[speed]`.
  **Nie** `discord.py` parallel installieren (beide belegen das Paket `discord`).

## Commands, Kontexte, Rechte
```python
import discord
from discord import IntegrationType, InteractionContextType

bot = discord.Bot(intents=discord.Intents.default())          # debug_guilds=[GUILD_ID] für Dev-Sync

@bot.slash_command(
    name="warn", description="User verwarnen",
    contexts={InteractionContextType.guild},                   # ersetzt guild_only (deprecated seit 2.6)
    integration_types={IntegrationType.guild_install},
)
@discord.default_permissions(moderate_members=True)            # nur UI-Vorfilter!
async def warn(ctx: discord.ApplicationContext, member: discord.Member, reason: str):
    if not ctx.author.guild_permissions.moderate_members:      # Backend-Check (Admins können Overrides setzen)
        return await ctx.respond("Keine Berechtigung.", ephemeral=True)
    if member.top_role >= ctx.author.top_role or member == ctx.author:
        return await ctx.respond("Ziel nicht erlaubt.", ephemeral=True)
    ...
```
- `contexts`/`integration_types` gehen nur bei **globalen** Commands (py-cord wirft bei `guild_ids`).
- Sync: `Bot` synct Commands beim Start automatisch (`auto_sync_commands=True`); `debug_guilds` = sofort
  sichtbare Guild-Commands für Tests. Gleiche Limits wie discord.js (100 Slash, 15/15 Context, 200 Creates/Tag/Guild).
- `ephemeral=True` ist in py-cord weiterhin korrekt (kein Deprecation wie in discord.js).

## Views / Components V2 / Modals
```python
class ConfirmView(discord.ui.View):
    def __init__(self, owner_id: int):
        super().__init__(timeout=60)
        self.owner_id = owner_id

    async def interaction_check(self, interaction: discord.Interaction) -> bool:   # gilt für ALLE Items
        if interaction.user.id != self.owner_id:
            await interaction.response.send_message("Nicht dein Button.", ephemeral=True)
            return False
        return True

    @discord.ui.button(label="Bestätigen", style=discord.ButtonStyle.danger)
    async def confirm(self, button: discord.ui.Button, interaction: discord.Interaction):
        ...
```
- Components V2: `DesignerView` mit `Container`, `Section`, `TextDisplay`, `Thumbnail`, `MediaGallery`,
  `Separator`, `File`; Buttons/Selects dort nur in einer `ActionRow`.
- Modals V2: `DesignerModal` mit `discord.ui.Label("Titel", discord.ui.InputText(...))`, `Select`,
  `FileUpload`, `RadioGroup`/`CheckboxGroup`/`Checkbox` jeweils im `Label`; `TextDisplay` direkt.
  `InputText.description`/`Select.label` gibt es nicht mehr → Attribute von `Label`.
- Persistente Views (überleben Restart): `timeout=None` + feste `custom_id` + `bot.add_view(View())` beim Start;
  Zustand/Ownership aus der DB lesen, nie aus der `custom_id` allein.

## Sicherheit & Robustheit
- Token nur aus Env (`os.environ["TOKEN"]`), nie loggen; `.env` via `python-dotenv` (≥ 1.2.2).
- `interaction_check` bzw. explizite Checks vor jeder Aktion (wer, Rechte, Guild, Channel, Ziel-Hierarchie).
- Fehler: `@bot.event async def on_application_command_error(ctx, error)` → freundliche Meldung, Details ins Log.
- Blockierende Calls (requests, pymongo synchron, Bildverarbeitung) nie im Event-Loop:
  `await asyncio.to_thread(fn, ...)` oder async-Clients (`httpx.AsyncClient`, PyMongo Async API).
- Rate-Limits/Cooldowns: `@commands.cooldown` (ext.commands) oder eigener Store-Cooldown.
