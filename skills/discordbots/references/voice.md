# Voice: @discordjs/voice 0.19.2 + DAVE (E2EE)

**Pflicht seit 2026-03-01:** Discord unterstützt nur noch Ende-zu-Ende-verschlüsselte Calls (DAVE) in
Voice-Channels, DMs, Gruppen-DMs und Go-Live. Clients/Bots ohne DAVE können Calls nicht mehr beitreten
(Discord-Changelog „Deprecating Non-E2EE Voice Calls", 2025-09-02).

## Versionen (npm, 2026-09)
| Paket | Stand | Hinweis |
|---|---|---|
| `@discordjs/voice` | **0.19.2** (2026-03-17) | Node **≥ 22.12.0**; DAVE seit 0.19.0; ab 0.19.1 ist `@snazzah/davey` feste Dependency („DAVE is becoming required"); Voice-Gateway v8 |
| `@snazzah/davey` | 0.1.12 | einzige unterstützte DAVE-Lib, wird automatisch installiert |
| Opus | `@discordjs/opus` 0.10.0 (nativ, schnell) **oder** `opusscript` (WASM/JS) | eins davon installieren |
| Verschlüsselung | nichts nötig, wenn `require('node:crypto').getCiphers().includes('aes-256-gcm')`; sonst `sodium-native`, `sodium`, `@stablelib/xchacha20poly1305`, `@noble/ciphers` oder `libsodium-wrappers` | `tweetnacl` wird **nicht** mehr unterstützt (0.18) |
| FFmpeg | System-FFmpeg oder `ffmpeg-static` | für Nicht-Opus-Quellen |

Upgrade-Pfad: jede `@discordjs/voice` < 0.19 → auf `^0.19.2`, Node ≥ 22.12, `tweetnacl` entfernen,
`generateDependencyReport()` einmal loggen und prüfen.

## Minimal (join + play, DAVE ist Default)
```js
const { joinVoiceChannel, createAudioPlayer, createAudioResource, entersState,
        VoiceConnectionStatus, AudioPlayerStatus, generateDependencyReport } = require('@discordjs/voice');

console.log(generateDependencyReport());                // Opus/Encryption/DAVE-Libs prüfen

const connection = joinVoiceChannel({
  channelId: channel.id,
  guildId: channel.guild.id,
  adapterCreator: channel.guild.voiceAdapterCreator,
  // daveEncryption: true (Default) — NICHT abschalten, sonst kein Join mehr möglich
  // decryptionFailureTolerance: 24 (Default) — Fehlversuche bis zur DAVE-Session-Neuverhandlung
});
try {
  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
} catch (e) {
  connection.destroy();                                  // sonst hängende Verbindung + Leak
  throw e;
}
const player = createAudioPlayer();
connection.subscribe(player);
player.play(createAudioResource('./sound.ogg'));
player.on(AudioPlayerStatus.Idle, () => connection.destroy());
player.on('error', (e) => console.error('[voice]', e.message));
```
- Intent `GuildVoiceStates` ist Pflicht für `voiceAdapterCreator`.
- Pro Guild nur **eine** Connection (`getVoiceConnection(guildId)` vor dem Join prüfen).
- Rechte prüfen: `Connect`, `Speak` (+ `UseSoundboard`/`UseExternalSounds` für Soundboard).
- Audio-Empfang (Aufnahme): DSGVO-relevant (Stimme = personenbezogen) — Einwilligung/Info-Pflicht.
- Soundboard: `voiceChannel.sendSoundboardSound(sound)` (14.19+) verlangt, dass der Bot im Channel verbunden ist.

## py-cord
`pip install "py-cord[voice]"` zieht `PyNaCl>=1.6.2,<1.7` + `davey>=0.1.4`; DAVE-Support für Senden ab
py-cord **2.8.0** (2026-05-18). `discord.VoiceClient` ist deprecated → `discord.voice.VoiceClient`.
