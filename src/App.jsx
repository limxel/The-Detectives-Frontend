import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { io } from 'socket.io-client';

// In production (after deploy) this reads VITE_SERVER_URL from the hosting
// platform's environment variables (set it to your deployed backend's URL,
// e.g. https://your-backend.onrender.com). Locally, with no .env file, it
// falls back to localhost so nothing changes for local development.
const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:5000';

const socket = io(SERVER_URL, {
  autoConnect: true,
  reconnection: true
});

const HOVER_SOUND = 'https://files.catbox.moe/jyzcnv.mp3';
const BACKGROUND_MUSIC = 'https://files.catbox.moe/cw1pml.mp3';
const EXPLORATION_AMBIENT = 'https://files.catbox.moe/bonni2.mp3';
const TRIAL_AMBIENT = 'https://files.catbox.moe/z42ff8.mp3';
const COUNTDOWN_TICK_SOUND = 'https://files.catbox.moe/u60x0l.wav';
const ROLE_REVEAL_SOUND = 'https://files.catbox.moe/ccsf9m.wav';
const INTRO_TYPING_LOOP_SOUND = 'https://files.catbox.moe/svl419.mp3';
const ABILITY_USE_SOUND = 'https://files.catbox.moe/nhfdld.mp3';
const VICTORY_SOUND = 'https://files.catbox.moe/9e3gv6.mp3';
const MURDER_SOUND = 'https://files.catbox.moe/nzupgt.mp3';
const DOPAMINE_CORNER_VIDEO = 'https://files.catbox.moe/eq3fwd.gif';

// Master volume, controlled by the settings slider. Kept outside the component
// so it's visible both to module-level functions (Web Audio effects) and to the
// button hover sound (NeonButton), which don't have access to App's React state.
let masterVolume = 0.4;

// Shared AudioContext for all short sound effects (countdown tick, role reveal,
// button hover). Web Audio API instead of a pool of <audio> nodes because:
//  - <audio> streams playback and the browser may decode on the fly, which caused
//    stuttering on uncompressed/large .wav files;
//  - Web Audio API decodes the file once into a PCM buffer in memory
//    (decodeAudioData), and every play() after that is just an instant start of an
//    AudioBufferSourceNode with no streaming involved;
//  - AudioBufferSourceNode is single-use (create -> start -> disposes itself), so
//    the same sound can safely overlap as many times as needed without a node pool.
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// Browsers create AudioContext in a 'suspended' state until a user gesture
// (click/tap) happens — resume() is safe to call repeatedly without erroring.
function resumeAudioContext() {
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
}
window.addEventListener('click', resumeAudioContext);
window.addEventListener('touchstart', resumeAudioContext, { passive: true });

// Creates a short-effect player: immediately starts fetching and decoding the
// whole file into a buffer (once), and returns a play(baseVolume) function that
// can be called any number of times — always plays from the start, no clicks
// or overlapping artifacts.
function createSfx(url) {
  let bufferPromise = fetch(url)
    .then((res) => res.arrayBuffer())
    .then((data) => audioCtx.decodeAudioData(data))
    .catch((err) => {
      console.log('SFX decode error for', url, err);
      return null;
    });

  // `rate` lets the same decoded buffer be reused as several distinct-feeling
  // stingers (e.g. a lower/slower playback reads as a "denied" buzz, a higher/
  // quicker one as a bright "confirm" chime) without fetching extra audio files.
  return function play(baseVolume = 0.5, rate = 1) {
    resumeAudioContext();
    bufferPromise.then((buffer) => {
      if (!buffer) return;
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = rate;

      const gainNode = audioCtx.createGain();
      // Short envelope on every one-shot so overlapping stingers never click
      // or pop — a hair of attack/release instead of an instant on/off.
      const now = audioCtx.currentTime;
      const peak = Math.max(0, Math.min(1, baseVolume * masterVolume));
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(peak, now + 0.012);

      source.connect(gainNode).connect(audioCtx.destination);
      source.start(0);
    });
  };
}

const playCountdownTick = createSfx(COUNTDOWN_TICK_SOUND);
const playRoleRevealSound = createSfx(ROLE_REVEAL_SOUND);
const playHoverSound = createSfx(HOVER_SOUND);
const playSkipVoteSound = createSfx(HOVER_SOUND);
// Dedicated one-shots (each its own fetched/decoded buffer, not a reuse of the
// sounds above): a single shared "used an ability" stinger for every role
// ability across the game, a proper victory cue for the GAME_OVER screen, and
// a proper murder cue for a landed kill.
const playAbilityUseSoundRaw = createSfx(ABILITY_USE_SOUND);
const playVictorySoundRaw = createSfx(VICTORY_SOUND);
const playMurderSoundRaw = createSfx(MURDER_SOUND);

// --- Additional UX stingers, built by reusing the sounds already loaded above
// at different volumes/playback rates, so no extra network fetches are needed.
const playTrialAlarm = (vol = 0.55) => { playRoleRevealSound(vol, 0.82); };       // trial opens: lower/slower = ominous
const playFragmentFoundSound = (vol = 0.5) => { playCountdownTick(vol, 1.6); };    // bright quick tick = "found it"
const playTrashFoundSound = (vol = 0.22) => { playHoverSound(vol, 0.9); };         // dull, low-key = "nothing much"
const playCodeErrorSound = (vol = 0.4) => { playCountdownTick(vol, 0.55); };       // slow/low = "denied" buzz
const playEvidencePlantedSound = (vol = 0.4) => { playRoleRevealSound(vol, 1.15); };
const playChatPingSound = (vol = 0.12) => { playHoverSound(vol, 1.35); };
const playVoteLockSound = (vol = 0.35) => { playSkipVoteSound(vol, 1); };
const playTrialTickSound = (vol = 0.4) => { playCountdownTick(vol, 1); };
const playVentEscapeSound = (vol = 0.4) => { playCountdownTick(vol, 1.4); };
// Every role-ability use in the game (joker evidence plant, forensic
// exam/verify, officer lock, detective check, accomplice evidence swap,
// killer vent/hide/expose, and room search for bodies/clues) funnels through
// this single stinger so ability usage always reads consistently.
const playAbilityUseSound = (vol = 0.75) => { playAbilityUseSoundRaw(vol, 1); };
const playGameOverSting = (vol = 0.95) => { playVictorySoundRaw(vol, 1); };
const playKillSound = (vol = 0.9) => { playMurderSoundRaw(vol, 1); };

const MIN_PLAYERS = 5;
const MAX_PLAYERS = 12;
const TURN_DURATION_SECONDS = 30;
const TRIAL_DURATION_SECONDS = 120;

// --- LANGUAGES: selectable in Settings. English, Russian, Ukrainian,
// Spanish, and German are actually wired up to the UI text right now (see
// `language` state and UI_TEXT below) — Italian and French remain
// placeholders for future localization, listed roughly by number of
// speakers worldwide.
const APP_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ru', label: 'Русский' },
  { code: 'uk', label: 'Українська' },
  { code: 'es', label: 'Español' },
  { code: 'de', label: 'Deutsch' },
  { code: 'it', label: 'Italiano' },
  { code: 'fr', label: 'Français' }
];

// --- UI TEXT: localized strings for every screen up to (but not including)
// the actual gameplay screen — nickname entry, main menu, play menu,
// servers list, join-by-code, create server, lobby, settings, and the
// dossier/rules screen. The gameplay screen itself (intro story, role
// reveal, action/trial phases, etc.) is intentionally left untranslated
// for now. Falls back to English for any language without a translation.
const UI_TEXT = {
  en: {
    enterNickname: 'ENTER NICKNAME',
    nicknamePlaceholder: 'YOUR CODE NAME...',
    initializeTerminal: 'INITIALIZE TERMINAL',
    launchCase: 'LAUNCH CASE',
    settings: 'SETTINGS',
    dossierRules: 'DOSSIER & RULES',
    selectOperation: 'Select Operation',
    publicLobbies: 'PUBLIC LOBBIES',
    secureConnection: 'SECURE CONNECTION (CODE)',
    establishHQ: 'ESTABLISH NEW HQ',
    return: 'RETURN',
    availableChannels: 'AVAILABLE ENCRYPTED CHANNELS',
    scanningFrequencies: 'Scanning frequencies... No active channels found.',
    idLabel: 'ID:',
    join: 'JOIN',
    back: 'BACK',
    enterDecryptionKey: 'ENTER DECRYPTION KEY',
    hexCodePlaceholder: '8-HEX CODE...',
    establishLink: 'ESTABLISH LINK',
    hqConfiguration: 'HQ CONFIGURATION',
    publicBroadcast: 'PUBLIC BROADCAST',
    publicBroadcastDesc: 'Listed in global frequency database. Open to all agents.',
    covertChannel: 'COVERT CHANNEL',
    covertChannelDesc: 'Encrypted overlay. Accessible strictly via direct terminal patch-in code.',
    hqBase: 'HQ BASE',
    preparing: 'PREPARING',
    open: 'OPEN',
    linkCode: 'LINK CODE:',
    selectProfile: 'SELECT PROFILE NETOP (1 UNIQUE PER IDENTITY)',
    taken: 'TAKEN',
    cancelReady: 'CANCEL READY STATE',
    confirmIdentity: 'CONFIRM IDENTITY (READY)',
    startOperation: 'START OPERATION',
    waitingForAgents: (count, min) => `WAITING FOR AGENTS (${count}/${min})`,
    waitingForHost: 'Waiting for host to launch the operation...',
    connectedChannels: 'CONNECTED CHANNELS',
    requiresPlayers: 'Requires at least 5 players to start',
    activeRolePool: 'ACTIVE ROLE POOL',
    fullTag: '(FULL)',
    baseTag: '(BASE)',
    allRolesUnlocked: 'All special roles unlock past 7 players.',
    rolesUnlockAt7: 'Special roles unlock past 7 players.',
    youTag: '(YOU)',
    hostTag: 'HOST',
    profileLabel: 'Profile:',
    selectingEllipsis: 'Selecting...',
    ready: 'READY',
    wait: 'WAIT',
    disconnect: 'DISCONNECT',
    terminalAdjustments: 'TERMINAL ADJUSTMENTS',
    hqAmbientMusic: 'HQ AMBIENT MUSIC',
    online: 'ONLINE',
    muted: 'MUTED',
    volumeLevel: 'VOLUME LEVEL',
    dopamineCorner: 'DOPAMINE CORNER',
    languages: 'LANGUAGES',
    classifiedDossier: 'CLASSIFIED DOSSIER',
    supportButton: 'SUPPORT',
    supportPopupTitle: 'NEED HELP?',
    supportPopupDesc: "Found a bug in the game, or running into a problem? Let us know at this email:",
    copyEmail: 'COPY EMAIL',
    emailCopied: 'COPIED!'
  },
  ru: {
    enterNickname: 'ВВЕДИТЕ НИКНЕЙМ',
    nicknamePlaceholder: 'ВАШ ПОЗЫВНОЙ...',
    initializeTerminal: 'ЗАПУСТИТЬ ТЕРМИНАЛ',
    launchCase: 'НАЧАТЬ ДЕЛО',
    settings: 'НАСТРОЙКИ',
    dossierRules: 'ДОСЬЕ И ПРАВИЛА',
    selectOperation: 'Выберите операцию',
    publicLobbies: 'ОТКРЫТЫЕ ЛОББИ',
    secureConnection: 'ЗАЩИЩЁННОЕ ПОДКЛЮЧЕНИЕ (КОД)',
    establishHQ: 'СОЗДАТЬ НОВЫЙ ШТАБ',
    return: 'НАЗАД',
    availableChannels: 'ДОСТУПНЫЕ ЗАШИФРОВАННЫЕ КАНАЛЫ',
    scanningFrequencies: 'Сканирование частот... Активных каналов не найдено.',
    idLabel: 'ID:',
    join: 'ВОЙТИ',
    back: 'НАЗАД',
    enterDecryptionKey: 'ВВЕДИТЕ КЛЮЧ ДЕШИФРОВКИ',
    hexCodePlaceholder: '8-СИМВОЛЬНЫЙ КОД...',
    establishLink: 'УСТАНОВИТЬ СВЯЗЬ',
    hqConfiguration: 'НАСТРОЙКА ШТАБА',
    publicBroadcast: 'ПУБЛИЧНАЯ ТРАНСЛЯЦИЯ',
    publicBroadcastDesc: 'Отображается в общей базе частот. Доступно всем агентам.',
    covertChannel: 'СКРЫТЫЙ КАНАЛ',
    covertChannelDesc: 'Зашифрованный канал. Доступ строго по прямому коду подключения терминала.',
    hqBase: 'БАЗА ШТАБА',
    preparing: 'ПОДГОТОВКА',
    open: 'ОТКРЫТО',
    linkCode: 'КОД СВЯЗИ:',
    selectProfile: 'ВЫБЕРИТЕ ПРОФИЛЬ (1 УНИКАЛЬНЫЙ НА ЛИЧНОСТЬ)',
    taken: 'ЗАНЯТО',
    cancelReady: 'ОТМЕНИТЬ ГОТОВНОСТЬ',
    confirmIdentity: 'ПОДТВЕРДИТЬ ЛИЧНОСТЬ (ГОТОВ)',
    startOperation: 'НАЧАТЬ ОПЕРАЦИЮ',
    waitingForAgents: (count, min) => `ОЖИДАНИЕ АГЕНТОВ (${count}/${min})`,
    waitingForHost: 'Ожидание запуска операции хостом...',
    connectedChannels: 'ПОДКЛЮЧЁННЫЕ КАНАЛЫ',
    requiresPlayers: 'Требуется минимум 5 игроков для начала',
    activeRolePool: 'АКТИВНЫЙ ПУЛ РОЛЕЙ',
    fullTag: '(ПОЛНЫЙ)',
    baseTag: '(БАЗОВЫЙ)',
    allRolesUnlocked: 'Все специальные роли открываются после 7 игроков.',
    rolesUnlockAt7: 'Специальные роли открываются после 7 игроков.',
    youTag: '(ВЫ)',
    hostTag: 'ХОСТ',
    profileLabel: 'Профиль:',
    selectingEllipsis: 'Выбор...',
    ready: 'ГОТОВ',
    wait: 'ОЖИДАНИЕ',
    disconnect: 'ОТКЛЮЧИТЬСЯ',
    terminalAdjustments: 'НАСТРОЙКИ ТЕРМИНАЛА',
    hqAmbientMusic: 'ФОНОВАЯ МУЗЫКА ШТАБА',
    online: 'ВКЛ',
    muted: 'ВЫКЛ',
    volumeLevel: 'УРОВЕНЬ ГРОМКОСТИ',
    dopamineCorner: 'ДОФАМИНОВЫЙ УГОЛОК',
    languages: 'ЯЗЫКИ',
    classifiedDossier: 'СЕКРЕТНОЕ ДОСЬЕ',
    supportButton: 'ПОДДЕРЖКА',
    supportPopupTitle: 'НУЖНА ПОМОЩЬ?',
    supportPopupDesc: 'Нашли баг в игре или столкнулись с проблемой? Напишите нам на эту почту:',
    copyEmail: 'СКОПИРОВАТЬ ПОЧТУ',
    emailCopied: 'СКОПИРОВАНО!'
  },
  uk: {
    enterNickname: 'ВВЕДІТЬ НІКНЕЙМ',
    nicknamePlaceholder: 'ВАШ ПОЗИВНИЙ...',
    initializeTerminal: 'ЗАПУСТИТИ ТЕРМІНАЛ',
    launchCase: 'РОЗПОЧАТИ СПРАВУ',
    settings: 'НАЛАШТУВАННЯ',
    dossierRules: 'ДОСЬЄ ТА ПРАВИЛА',
    selectOperation: 'Оберіть операцію',
    publicLobbies: 'ВІДКРИТІ ЛОБІ',
    secureConnection: "ЗАХИЩЕНЕ ПІДКЛЮЧЕННЯ (КОД)",
    establishHQ: 'СТВОРИТИ НОВИЙ ШТАБ',
    return: 'НАЗАД',
    availableChannels: 'ДОСТУПНІ ЗАШИФРОВАНІ КАНАЛИ',
    scanningFrequencies: 'Сканування частот... Активних каналів не знайдено.',
    idLabel: 'ID:',
    join: 'УВІЙТИ',
    back: 'НАЗАД',
    enterDecryptionKey: 'ВВЕДІТЬ КЛЮЧ РОЗШИФРУВАННЯ',
    hexCodePlaceholder: '8-СИМВОЛЬНИЙ КОД...',
    establishLink: 'ВСТАНОВИТИ ЗВʼЯЗОК',
    hqConfiguration: 'НАЛАШТУВАННЯ ШТАБУ',
    publicBroadcast: 'ПУБЛІЧНА ТРАНСЛЯЦІЯ',
    publicBroadcastDesc: 'Відображається в загальній базі частот. Доступно всім агентам.',
    covertChannel: 'ПРИХОВАНИЙ КАНАЛ',
    covertChannelDesc: 'Зашифрований канал. Доступ лише за прямим кодом підключення термінала.',
    hqBase: 'БАЗА ШТАБУ',
    preparing: 'ПІДГОТОВКА',
    open: 'ВІДКРИТО',
    linkCode: "КОД ЗВ'ЯЗКУ:",
    selectProfile: 'ОБЕРІТЬ ПРОФІЛЬ (1 УНІКАЛЬНИЙ НА ОСОБУ)',
    taken: 'ЗАЙНЯТО',
    cancelReady: 'СКАСУВАТИ ГОТОВНІСТЬ',
    confirmIdentity: 'ПІДТВЕРДИТИ ОСОБУ (ГОТОВИЙ)',
    startOperation: 'РОЗПОЧАТИ ОПЕРАЦІЮ',
    waitingForAgents: (count, min) => `ОЧІКУВАННЯ АГЕНТІВ (${count}/${min})`,
    waitingForHost: 'Очікування запуску операції хостом...',
    connectedChannels: 'ПІДКЛЮЧЕНІ КАНАЛИ',
    requiresPlayers: 'Потрібно щонайменше 5 гравців для початку',
    activeRolePool: 'АКТИВНИЙ ПУЛ РОЛЕЙ',
    fullTag: '(ПОВНИЙ)',
    baseTag: '(БАЗОВИЙ)',
    allRolesUnlocked: 'Усі спеціальні ролі відкриваються після 7 гравців.',
    rolesUnlockAt7: 'Спеціальні ролі відкриваються після 7 гравців.',
    youTag: '(ВИ)',
    hostTag: 'ХОСТ',
    profileLabel: 'Профіль:',
    selectingEllipsis: 'Вибір...',
    ready: 'ГОТОВИЙ',
    wait: 'ОЧІКУВАННЯ',
    disconnect: "ВІД'ЄДНАТИСЯ",
    terminalAdjustments: 'НАЛАШТУВАННЯ ТЕРМІНАЛА',
    hqAmbientMusic: 'ФОНОВА МУЗИКА ШТАБУ',
    online: 'УВІМК',
    muted: 'ВИМК',
    volumeLevel: 'РІВЕНЬ ГУЧНОСТІ',
    dopamineCorner: 'ДОФАМІНОВИЙ КУТОЧОК',
    languages: 'МОВИ',
    classifiedDossier: 'СЕКРЕТНЕ ДОСЬЄ',
    supportButton: 'ПІДТРИМКА',
    supportPopupTitle: 'ПОТРІБНА ДОПОМОГА?',
    supportPopupDesc: 'Знайшли баг у грі чи зіткнулися з проблемою? Напишіть нам на цю пошту:',
    copyEmail: 'СКОПІЮВАТИ ПОШТУ',
    emailCopied: 'СКОПІЙОВАНО!'
  },
  es: {
    enterNickname: 'INGRESA APODO',
    nicknamePlaceholder: 'TU NOMBRE EN CLAVE...',
    initializeTerminal: 'INICIAR TERMINAL',
    launchCase: 'INICIAR CASO',
    settings: 'AJUSTES',
    dossierRules: 'EXPEDIENTE Y REGLAS',
    selectOperation: 'Seleccionar Operación',
    publicLobbies: 'SALAS PÚBLICAS',
    secureConnection: 'CONEXIÓN SEGURA (CÓDIGO)',
    establishHQ: 'ESTABLECER NUEVO CUARTEL',
    return: 'VOLVER',
    availableChannels: 'CANALES CIFRADOS DISPONIBLES',
    scanningFrequencies: 'Escaneando frecuencias... No se encontraron canales activos.',
    idLabel: 'ID:',
    join: 'UNIRSE',
    back: 'ATRÁS',
    enterDecryptionKey: 'INGRESA CLAVE DE DESCIFRADO',
    hexCodePlaceholder: 'CÓDIGO DE 8 DÍGITOS HEX...',
    establishLink: 'ESTABLECER ENLACE',
    hqConfiguration: 'CONFIGURACIÓN DEL CUARTEL',
    publicBroadcast: 'TRANSMISIÓN PÚBLICA',
    publicBroadcastDesc: 'Aparece en la base de datos global de frecuencias. Abierto a todos los agentes.',
    covertChannel: 'CANAL ENCUBIERTO',
    covertChannelDesc: 'Superposición cifrada. Accesible únicamente mediante código de conexión directa al terminal.',
    hqBase: 'BASE DEL CUARTEL',
    preparing: 'PREPARANDO',
    open: 'ABIERTO',
    linkCode: 'CÓDIGO DE ENLACE:',
    selectProfile: 'SELECCIONA PERFIL (1 ÚNICO POR PERSONA)',
    taken: 'OCUPADO',
    cancelReady: 'CANCELAR LISTO',
    confirmIdentity: 'CONFIRMAR IDENTIDAD (LISTO)',
    startOperation: 'INICIAR OPERACIÓN',
    waitingForAgents: (count, min) => `ESPERANDO AGENTES (${count}/${min})`,
    waitingForHost: 'Esperando a que el anfitrión inicie la operación...',
    connectedChannels: 'CANALES CONECTADOS',
    requiresPlayers: 'Se requieren al menos 5 jugadores para empezar',
    activeRolePool: 'GRUPO DE ROLES ACTIVO',
    fullTag: '(COMPLETO)',
    baseTag: '(BÁSICO)',
    allRolesUnlocked: 'Todos los roles especiales se desbloquean a partir de 7 jugadores.',
    rolesUnlockAt7: 'Los roles especiales se desbloquean a partir de 7 jugadores.',
    youTag: '(TÚ)',
    hostTag: 'ANFITRIÓN',
    profileLabel: 'Perfil:',
    selectingEllipsis: 'Seleccionando...',
    ready: 'LISTO',
    wait: 'ESPERAR',
    disconnect: 'DESCONECTAR',
    terminalAdjustments: 'AJUSTES DEL TERMINAL',
    hqAmbientMusic: 'MÚSICA AMBIENTAL DEL CUARTEL',
    online: 'ACTIVADO',
    muted: 'SILENCIADO',
    volumeLevel: 'NIVEL DE VOLUMEN',
    dopamineCorner: 'RINCÓN DE DOPAMINA',
    languages: 'IDIOMAS',
    classifiedDossier: 'EXPEDIENTE CLASIFICADO',
    supportButton: 'SOPORTE',
    supportPopupTitle: '¿NECESITAS AYUDA?',
    supportPopupDesc: '¿Encontraste un error en el juego o tienes un problema? Escríbenos a este correo:',
    copyEmail: 'COPIAR CORREO',
    emailCopied: '¡COPIADO!'
  },
  de: {
    enterNickname: 'SPITZNAMEN EINGEBEN',
    nicknamePlaceholder: 'DEIN CODENAME...',
    initializeTerminal: 'TERMINAL INITIALISIEREN',
    launchCase: 'FALL STARTEN',
    settings: 'EINSTELLUNGEN',
    dossierRules: 'DOSSIER & REGELN',
    selectOperation: 'Operation auswählen',
    publicLobbies: 'ÖFFENTLICHE LOBBYS',
    secureConnection: 'SICHERE VERBINDUNG (CODE)',
    establishHQ: 'NEUES HQ ERRICHTEN',
    return: 'ZURÜCK',
    availableChannels: 'VERFÜGBARE VERSCHLÜSSELTE KANÄLE',
    scanningFrequencies: 'Frequenzen werden gescannt... Keine aktiven Kanäle gefunden.',
    idLabel: 'ID:',
    join: 'BEITRETEN',
    back: 'ZURÜCK',
    enterDecryptionKey: 'ENTSCHLÜSSELUNGSCODE EINGEBEN',
    hexCodePlaceholder: '8-STELLIGER HEX-CODE...',
    establishLink: 'VERBINDUNG HERSTELLEN',
    hqConfiguration: 'HQ-KONFIGURATION',
    publicBroadcast: 'ÖFFENTLICHE ÜBERTRAGUNG',
    publicBroadcastDesc: 'Wird in der globalen Frequenzdatenbank gelistet. Offen für alle Agenten.',
    covertChannel: 'VERDECKTER KANAL',
    covertChannelDesc: 'Verschlüsselte Überlagerung. Zugang nur über direkten Terminal-Verbindungscode.',
    hqBase: 'HQ-BASIS',
    preparing: 'VORBEREITUNG',
    open: 'OFFEN',
    linkCode: 'VERBINDUNGSCODE:',
    selectProfile: 'PROFIL AUSWÄHLEN (1 EINZIGARTIG PRO IDENTITÄT)',
    taken: 'VERGEBEN',
    cancelReady: 'BEREITSCHAFT ABBRECHEN',
    confirmIdentity: 'IDENTITÄT BESTÄTIGEN (BEREIT)',
    startOperation: 'OPERATION STARTEN',
    waitingForAgents: (count, min) => `WARTEN AUF AGENTEN (${count}/${min})`,
    waitingForHost: 'Warten, bis der Host die Operation startet...',
    connectedChannels: 'VERBUNDENE KANÄLE',
    requiresPlayers: 'Mindestens 5 Spieler zum Start erforderlich',
    activeRolePool: 'AKTIVER ROLLENPOOL',
    fullTag: '(VOLL)',
    baseTag: '(BASIS)',
    allRolesUnlocked: 'Alle Sonderrollen werden ab 7 Spielern freigeschaltet.',
    rolesUnlockAt7: 'Sonderrollen werden ab 7 Spielern freigeschaltet.',
    youTag: '(DU)',
    hostTag: 'HOST',
    profileLabel: 'Profil:',
    selectingEllipsis: 'Auswahl läuft...',
    ready: 'BEREIT',
    wait: 'WARTEN',
    disconnect: 'TRENNEN',
    terminalAdjustments: 'TERMINALEINSTELLUNGEN',
    hqAmbientMusic: 'HQ-HINTERGRUNDMUSIK',
    online: 'AN',
    muted: 'STUMM',
    volumeLevel: 'LAUTSTÄRKE',
    dopamineCorner: 'DOPAMIN-ECKE',
    languages: 'SPRACHEN',
    classifiedDossier: 'GEHEIMES DOSSIER',
    supportButton: 'SUPPORT',
    supportPopupTitle: 'BRAUCHST DU HILFE?',
    supportPopupDesc: 'Einen Bug im Spiel gefunden oder ein Problem? Schreib uns an diese E-Mail:',
    copyEmail: 'E-MAIL KOPIEREN',
    emailCopied: 'KOPIERT!'
  },
  fr: {
    enterNickname: 'ENTREZ VOTRE PSEUDO',
    nicknamePlaceholder: 'VOTRE NOM DE CODE...',
    initializeTerminal: 'INITIALISER LE TERMINAL',
    launchCase: "LANCER L'AFFAIRE",
    settings: 'PARAMÈTRES',
    dossierRules: 'DOSSIER ET RÈGLES',
    selectOperation: 'Sélectionner une opération',
    publicLobbies: 'SALONS PUBLICS',
    secureConnection: 'CONNEXION SÉCURISÉE (CODE)',
    establishHQ: 'CRÉER UN NOUVEAU QG',
    return: 'RETOUR',
    availableChannels: 'CANAUX CHIFFRÉS DISPONIBLES',
    scanningFrequencies: 'Recherche de fréquences... Aucun canal actif trouvé.',
    idLabel: 'ID :',
    join: 'REJOINDRE',
    back: 'RETOUR',
    enterDecryptionKey: 'ENTREZ LA CLÉ DE DÉCHIFFREMENT',
    hexCodePlaceholder: 'CODE HEX À 8 CARACTÈRES...',
    establishLink: 'ÉTABLIR LA LIAISON',
    hqConfiguration: 'CONFIGURATION DU QG',
    publicBroadcast: 'DIFFUSION PUBLIQUE',
    publicBroadcastDesc: 'Répertorié dans la base de données mondiale des fréquences. Ouvert à tous les agents.',
    covertChannel: 'CANAL SECRET',
    covertChannelDesc: 'Superposition chiffrée. Accessible uniquement via un code de connexion directe au terminal.',
    hqBase: 'BASE DU QG',
    preparing: 'PRÉPARATION',
    open: 'OUVERT',
    linkCode: 'CODE DE LIAISON :',
    selectProfile: 'SÉLECTIONNEZ UN PROFIL (1 UNIQUE PAR IDENTITÉ)',
    taken: 'PRIS',
    cancelReady: 'ANNULER LA PRÉPARATION',
    confirmIdentity: "CONFIRMER L'IDENTITÉ (PRÊT)",
    startOperation: "LANCER L'OPÉRATION",
    waitingForAgents: (count, min) => `EN ATTENTE D'AGENTS (${count}/${min})`,
    waitingForHost: "En attente que l'hôte lance l'opération...",
    connectedChannels: 'CANAUX CONNECTÉS',
    requiresPlayers: 'Au moins 5 joueurs requis pour commencer',
    activeRolePool: 'BASSIN DE RÔLES ACTIF',
    fullTag: '(COMPLET)',
    baseTag: '(DE BASE)',
    allRolesUnlocked: 'Tous les rôles spéciaux se débloquent à partir de 7 joueurs.',
    rolesUnlockAt7: 'Les rôles spéciaux se débloquent à partir de 7 joueurs.',
    youTag: '(VOUS)',
    hostTag: 'HÔTE',
    profileLabel: 'Profil :',
    selectingEllipsis: 'Sélection...',
    ready: 'PRÊT',
    wait: 'ATTENDRE',
    disconnect: 'DÉCONNEXION',
    terminalAdjustments: 'RÉGLAGES DU TERMINAL',
    hqAmbientMusic: "MUSIQUE D'AMBIANCE DU QG",
    online: 'ACTIVÉ',
    muted: 'COUPÉ',
    volumeLevel: 'NIVEAU DE VOLUME',
    dopamineCorner: 'COIN DOPAMINE',
    languages: 'LANGUES',
    classifiedDossier: 'DOSSIER CLASSIFIÉ',
    supportButton: 'SOUTIEN',
    supportPopupTitle: "BESOIN D'AIDE ?",
    supportPopupDesc: 'Vous avez trouvé un bug dans le jeu ou rencontrez un problème ? Écrivez-nous à cette adresse :',
    copyEmail: "COPIER L'E-MAIL",
    emailCopied: 'COPIÉ !'
  }
};

// KEEP IN SYNC WITH backend/index.js — this dossier copy must match the
// server-authoritative CHARACTERS roster used by generateForensicClue.
const CHARACTERS = [
  { name: 'Creed', url: 'https://i.postimg.cc/xjJPpJNY/2fdb739d-84b9-4d0d-8170-d281954a8b7c.jpg', realName: 'Creed Vance', height: '188 cm', weight: '85 kg', bloodType: 'A+', hobbies: 'Bidding on multi-million dollar digital art auctions, collecting physical vintage luxury watches, drinking rare red wine.' },
  { name: 'Karl', url: 'https://i.postimg.cc/nVj1Sj9c/4169de45-bccb-49a2-bea0-6e41091a9453.jpg', realName: 'Karl Thorne', height: '178 cm', weight: '68 kg', bloodType: 'A+', hobbies: 'Practicing classical fencing with custom steel foils, attending grand opera premieres, studying royal family genealogy.' },
  { name: 'Anthonio', url: 'https://i.postimg.cc/VsrFZr0z/53b8e637-00ec-4baa-bdb8-4bdb01564a54.jpg', realName: 'Anthonio Rossi', height: '185 cm', weight: '110 kg', bloodType: 'O+', hobbies: 'Feeding wild ducks in his pool, smoking expensive imported cigars, managing garbage disposal contracts.' },
  { name: 'James', url: 'https://i.postimg.cc/1RnK7nVm/61da301d-4838-4b30-9e52-45146fe8882d.jpg', realName: 'James Creed', height: '183 cm', weight: '82 kg', bloodType: 'B+', hobbies: 'Shredding heavy metal riffs on a custom black Explorer guitar, restoring vintage V8 muscle cars, collecting hunting rifles.' },
  { name: 'Cedric', url: 'https://i.postimg.cc/Kck5pk3c/6684a55e-28ee-44cb-9ecc-554d44540f8c.jpg', realName: 'Cedric Rostova', height: '180 cm', weight: '84 kg', bloodType: 'O+', hobbies: 'Prison-style heavy calisthenics, sketching monochrome tattoo designs, carving makeshift tools out of spare scrap metal.' },
  { name: 'Lidy', url: 'https://i.postimg.cc/gcXKtXLJ/74409a55-7ddb-4fae-bc0a-0d21aa1ae1be.jpg', realName: 'Lidy Vance', height: '168 cm', weight: '62 kg', bloodType: 'A-', hobbies: 'Baking homemade cherry pies, knitting wool sweaters, reading paperback detective novels.' },
  { name: 'May', url: 'https://i.postimg.cc/c1gckgtC/a7af6a30-acf5-4e55-b9ed-4ed5080008fe.jpg', realName: 'May Creed', height: '152 cm', weight: '42 kg', bloodType: 'B+', hobbies: 'Picking glowing bioluminescent forest mushrooms, crafting flower crowns, collecting sparkling dust in small glass jars.' },
  { name: 'Gregory', url: 'https://i.postimg.cc/dQk9NkZD/aa60cee7-e3c9-460a-943a-70f505b8526a.jpg', realName: 'Dr. Gregory Chen', height: '182 cm', weight: '75 kg', bloodType: 'A-', hobbies: 'Practicing micro-stitch sewing on synthetic skin, collecting historical surgical scalpels, studying forensic human anatomy.' },
  { name: 'Onyx', url: 'https://i.postimg.cc/BZLC7LPX/c218fab0-360a-4de0-9fcf-cc7cd2180f9d.jpg', realName: 'Onyx Grey', height: '174 cm', weight: '58 kg', bloodType: 'B-', hobbies: 'Writing melancholic poetry in a locked black journal, collecting midwest emo vinyl records, hanging out alone in dark, rainy places.' },
  { name: 'Max', url: 'https://i.postimg.cc/2jbx9bLq/f11eb0a7-dda4-4845-8793-2daac4d4bbf0.jpg', realName: 'Max Tanaka', height: '176 cm', weight: '64 kg', bloodType: 'B-', hobbies: 'Drawing chaotic, repetitive patterns on walls with charcoal, talking to invisible visitors, hoarding colorful prescription pills.' },
  { name: 'Bea', url: 'https://i.postimg.cc/JzvwXxK8/54afbcca-49b7-4570-8b15-38936afa1975.jpg', realName: 'Bea Gray', height: '180 cm', weight: '70 kg', bloodType: 'A+', hobbies: 'Training sword strikes with an authentic Japanese katana, updating a personal handwritten revenge checklist, intense martial arts meditation.' },
  { name: 'Moonka', url: 'https://i.postimg.cc/ht6FmsMF/28b49642-1595-46cb-b607-f0b7fbce307a.jpg', realName: 'Moonka Miller', height: '164 cm', weight: '53 kg', bloodType: 'O+', hobbies: 'Writing deep metaphorical poems for a literature club, playing sad classical piano melodies, writing script codes.' }
];

// --- ROLES: color, sprite, short description ---
const ROLES = {
  Killer: {
    label: 'KILLER',
    labelRu: 'УБИЙЦА',
    labelUk: 'ВБИВЦЯ',
    color: '#ff2a5f',
    sprite: 'https://i.postimg.cc/K8WMPW4s/15c3aab1-6af8-4f71-8190-91a3017ae631.jpg',
    description: 'Eliminate targets under cover of night. One strike per turn.',
    descriptionRu: 'Устраняйте цели под покровом ночи. Один удар за ход.',
    descriptionUk: 'Усувайте цілі під покровом ночі. Один удар за хід.',
    labelEs: 'ASESINO',
    descriptionEs: 'Elimina objetivos al amparo de la noche. Un golpe por turno.',
    labelDe: 'MÖRDER',
    descriptionDe: 'Schalte Ziele im Schutz der Nacht aus. Ein Schlag pro Zug.',
    labelFr: 'TUEUR',
    descriptionFr: 'Éliminez des cibles sous le couvert de la nuit. Un coup par tour.'
  },
  Accomplice: {
    label: 'ACCOMPLICE',
    labelRu: 'СООБЩНИК',
    labelUk: 'СПІВУЧАСНИК',
    color: '#ff2a5f',
    sprite: 'https://i.postimg.cc/FH6Ly61T/1bff526b-381a-4464-8439-bcb173ddda17.jpg',
    description: 'Scramble the evidence feeds. You receive the Killer\'s reports.',
    descriptionRu: 'Искажайте потоки улик. Вы получаете отчёты Убийцы.',
    descriptionUk: 'Спотворюйте потоки доказів. Ви отримуєте звіти Вбивці.',
    labelEs: 'CÓMPLICE',
    descriptionEs: 'Distorsiona los reportes de evidencia. Recibes los informes del Asesino.',
    labelDe: 'KOMPLIZE',
    descriptionDe: 'Verfälsche die Beweisberichte. Du erhältst die Berichte des Mörders.',
    labelFr: 'COMPLICE',
    descriptionFr: "Brouillez les flux de preuves. Vous recevez les rapports du Tueur."
  },
  Innocent: {
    label: 'INNOCENT',
    labelRu: 'НЕВИННЫЙ',
    labelUk: 'НЕВИННИЙ',
    color: '#00ff87',
    sprite: 'https://i.postimg.cc/sgLhYL1N/bb4a6ebf-afab-4e2a-bee8-df0067360ba6.jpg',
    description: 'Search the mansion for the override code. Find it, and escape quarantine.',
    descriptionRu: 'Ищите по особняку код отмены протокола. Найдите его — и выберитесь из карантина.',
    descriptionUk: 'Шукайте по особняку код скасування протоколу. Знайдіть його — і вийдіть з карантину.',
    labelEs: 'INOCENTE',
    descriptionEs: 'Busca en la mansión el código de anulación. Encuéntralo y escapa de la cuarentena.',
    labelDe: 'UNSCHULDIGER',
    descriptionDe: 'Durchsuche das Anwesen nach dem Freigabecode. Finde ihn und entkomme der Quarantäne.',
    labelFr: 'INNOCENT',
    descriptionFr: "Fouillez le manoir à la recherche du code de remplacement. Trouvez-le et échappez à la quarantaine."
  },
  Detective: {
    label: 'DETECTIVE',
    labelRu: 'ДЕТЕКТИВ',
    labelUk: 'ДЕТЕКТИВ',
    color: '#00f0ff',
    sprite: 'https://i.postimg.cc/vZKVrKDK/082786d9-31b4-474f-acba-562a20ec018a.jpg',
    description: 'Shadow a profile\'s network path. One trace per turn.',
    descriptionRu: 'Отслеживайте сетевой путь подозреваемого. Одна проверка за ход.',
    descriptionUk: 'Відстежуйте мережевий шлях підозрюваного. Одна перевірка за хід.',
    labelEs: 'DETECTIVE',
    descriptionEs: 'Rastrea la trayectoria de red de un sospechoso. Una comprobación por turno.',
    labelDe: 'DETEKTIV',
    descriptionDe: 'Verfolge den Netzwerkpfad eines Profils. Eine Ortung pro Zug.',
    labelFr: 'DÉTECTIVE',
    descriptionFr: "Filez le parcours réseau d'un profil. Un repérage par tour."
  },
  Officer: {
    label: 'OFFICER',
    labelRu: 'ОФИЦЕР',
    labelUk: 'ОФІЦЕР',
    color: '#00f0ff',
    sprite: 'https://i.postimg.cc/vZKVrKDk/dc83107d-3ed0-46d0-84ac-72ceb725ebf4.jpg',
    description: 'Shield an ally from harm. One protocol lock every 3 turns.',
    descriptionRu: 'Защищайте союзника от опасности. Один протокольный захват раз в 3 хода.',
    descriptionUk: 'Захищайте союзника від небезпеки. Одне протокольне блокування раз на 3 ходи.',
    labelEs: 'OFICIAL',
    descriptionEs: 'Protege a un aliado del peligro. Un bloqueo de protocolo cada 3 turnos.',
    labelDe: 'OFFIZIER',
    descriptionDe: 'Beschütze einen Verbündeten vor Schaden. Eine Protokollsperre alle 3 Züge.',
    labelFr: 'OFFICIER',
    descriptionFr: 'Protégez un allié du danger. Un verrouillage de protocole tous les 3 tours.'
  },
  Forensic: {
    label: 'FORENSIC',
    labelRu: 'КРИМИНАЛИСТ',
    labelUk: 'КРИМІНАЛІСТ',
    color: '#00f0ff',
    sprite: 'https://i.postimg.cc/fRP9cPk1/d9a46ad6-0508-43b9-bd5a-28e1e378bf48.jpg',
    description: 'Authenticate telemetry validity. One analysis every 2 turns.',
    descriptionRu: 'Проверяйте подлинность телеметрии. Один анализ раз в 2 хода.',
    descriptionUk: 'Перевіряйте автентичність телеметрії. Один аналіз раз на 2 ходи.',
    labelEs: 'FORENSE',
    descriptionEs: 'Verifica la autenticidad de la telemetría. Un análisis cada 2 turnos.',
    labelDe: 'FORENSIKER',
    descriptionDe: 'Prüfe die Echtheit der Telemetrie. Eine Analyse alle 2 Züge.',
    labelFr: 'CRIMINALISTE',
    descriptionFr: 'Authentifiez la validité de la télémétrie. Une analyse tous les 2 tours.'
  },
  Joker: {
    label: 'JOKER',
    labelRu: 'ДЖОКЕР',
    labelUk: 'ДЖОКЕР',
    color: '#e040fb',
    sprite: 'https://i.postimg.cc/Cx2qG2dr/12d256b6-17de-4a39-b551-44760940de79.jpg',
    description: 'Wanted dead. You win if the council votes to execute you. Plant a piece of personal evidence in a searched room once every 2 turns.',
    descriptionRu: 'Разыскивается для устранения. Вы побеждаете, если совет проголосует за вашу казнь. Подбрасывайте личную улику в обысканной комнате раз в 2 хода.',
    descriptionUk: 'Розшукується для усунення. Ви перемагаєте, якщо рада проголосує за вашу страту. Підкидайте особисту доказ у обшуканій кімнаті раз на 2 ходи.',
    labelEs: 'BROMISTA',
    descriptionEs: 'Buscado para ser eliminado. Ganas si el consejo vota por tu ejecución. Planta una evidencia personal en una sala registrada una vez cada 2 turnos.',
    labelDe: 'JOKER',
    descriptionDe: 'Zum Abschuss freigegeben. Du gewinnst, wenn der Rat für deine Hinrichtung stimmt. Platziere alle 2 Züge ein persönliches Beweisstück in einem durchsuchten Raum.',
    labelFr: 'JOKER',
    descriptionFr: "Recherché pour élimination. Vous gagnez si le conseil vote votre exécution. Placez une preuve personnelle dans une pièce fouillée une fois tous les 2 tours."
  }
};

const BASE_ROLE_NAMES = ['Killer', 'Detective', 'Officer'];
const SPECIAL_ROLE_NAMES = ['Joker', 'Accomplice', 'Forensic'];

// This is a public lobby preview only. Actual role assignment remains entirely
// server-side and each player receives only their own role once the game starts.
// The preview is always shown as if the lobby already had at least MIN_PLAYERS
// players, so the base composition (Killer/Detective/Officer + Innocents) is
// visible immediately instead of Innocents only "appearing" as people join.
function getRolePoolPreview(playerCount) {
  const effectivePlayerCount = Math.max(playerCount, MIN_PLAYERS);
  const uniqueRoles = effectivePlayerCount > 7
    ? [...BASE_ROLE_NAMES, ...SPECIAL_ROLE_NAMES]
    : BASE_ROLE_NAMES;

  return [
    ...uniqueRoles.map((name) => ({ name, count: 1 })),
    { name: 'Innocent', count: Math.max(0, effectivePlayerCount - uniqueRoles.length) }
  ].filter((role) => role.count > 0);
}

const INTRO_STORY = `The mahogany table was filled with crystal decanters and vintage wine. Lord Alistair Vance, a tech mogul worth billions, raised his glass.
"To progress," he toasted.
He took a drink. Seconds later, the glass shattered. Alistair gasped, clutching his throat as his veins turned violet, and slumped lifelessly onto the silver platters.
Before anyone could scream, a heavy mechanical thud reverberated through the mansion. Massive steel shutters sealed every window. The heavy oak doors locked automatically.
Suddenly, the wall terminal flickered to life. A cold, synthetic voice filled the room:
"PROTOCOL OMEGA ENGAGED. Host status: TERMINATED. All exits sealed under absolute quarantine for 24 hours. Identify the killer among you, or the terminal vault will be purged."
Guests looked at one another in terrifying silence. The storm outside raged against the steel, but the real danger was sitting at the table. The quarantine had begun.`;

const INTRO_STORY_RU = `Стол красного дерева был уставлен хрустальными графинами и марочным вином. Лорд Алистер Вэнс, технологический магнат стоимостью в миллиарды, поднял бокал.
«За прогресс», — произнёс он тост.
Он сделал глоток. Через несколько секунд бокал разлетелся вдребезги. Алистер задохнулся, схватившись за горло — вены налились фиолетовым, — и безжизненно рухнул на серебряные подносы.
Прежде чем кто-либо успел закричать, по особняку прокатился тяжёлый механический гул. Массивные стальные ставни запечатали каждое окно. Тяжёлые дубовые двери заперлись автоматически.
Внезапно настенный терминал ожил. Холодный синтетический голос заполнил комнату:
«ПРОТОКОЛ ОМЕГА АКТИВИРОВАН. Статус хозяина: ЛИКВИДИРОВАН. Все выходы запечатаны под абсолютным карантином на 24 часа. Определите убийцу среди вас, иначе хранилище терминала будет уничтожено».
Гости в ужасе переглянулись в мёртвой тишине. Снаружи бушевала буря, обрушиваясь на сталь, но настоящая опасность сидела прямо за этим столом. Карантин начался.`;

const INTRO_STORY_UK = `Стіл із червоного дерева був заставлений кришталевими графинами та марочним вином. Лорд Алістер Венс, технологічний магнат вартістю в мільярди, підняв келих.
«За прогрес», — виголосив він тост.
Він зробив ковток. За кілька секунд келих розлетівся на друзки. Алістер задихнувся, схопившись за горло — вени налилися фіолетовим, — і безживно впав на срібні таці.
Перш ніж хтось встиг закричати, особняком прокотився важкий механічний гул. Масивні сталеві віконниці запечатали кожне вікно. Важкі дубові двері замкнулися автоматично.
Раптом настінний термінал ожив. Холодний синтетичний голос наповнив кімнату:
«ПРОТОКОЛ ОМЕГА АКТИВОВАНО. Статус господаря: ЛІКВІДОВАНО. Усі виходи запечатані під абсолютним карантином на 24 години. Визначте вбивцю серед вас, інакше сховище термінала буде знищено».
Гості в жаху перезирнулися в мертвій тиші. Надворі шаленіла буря, накидаючись на сталь, але справжня небезпека сиділа прямо за цим столом. Карантин розпочався.`;

const INTRO_STORY_ES = `La mesa de caoba estaba llena de decantadores de cristal y vino añejo. Lord Alistair Vance, un magnate tecnológico multimillonario, levantó su copa.
"Por el progreso", brindó.
Bebió un trago. Segundos después, la copa se hizo añicos. Alistair jadeó, aferrándose la garganta mientras sus venas se volvían violáceas, y se desplomó sin vida sobre las bandejas de plata.
Antes de que nadie pudiera gritar, un pesado golpe mecánico retumbó por toda la mansión. Persianas de acero masivas sellaron todas las ventanas. Las pesadas puertas de roble se cerraron automáticamente.
De repente, el terminal de la pared cobró vida. Una voz fría y sintética llenó la sala:
"PROTOCOLO OMEGA ACTIVADO. Estado del anfitrión: TERMINADO. Todas las salidas selladas bajo cuarentena absoluta durante 24 horas. Identifiquen al asesino entre ustedes, o la bóveda del terminal será purgada."
Los invitados se miraron unos a otros en un silencio aterrador. La tormenta afuera azotaba el acero, pero el verdadero peligro estaba sentado a la mesa. La cuarentena había comenzado.`;

const INTRO_STORY_FR = `La table en acajou était couverte de carafes en cristal et de vin millésimé. Lord Alistair Vance, un magnat de la tech valant des milliards, leva son verre.
"Au progrès," porta-t-il un toast.
Il en but une gorgée. Quelques secondes plus tard, le verre vola en éclats. Alistair suffoqua, se tenant la gorge tandis que ses veines viraient au violet, et s'effondra sans vie sur les plateaux d'argent.
Avant que quiconque ne puisse crier, un lourd choc mécanique retentit dans tout le manoir. D'imposants volets d'acier scellèrent chaque fenêtre. Les lourdes portes en chêne se verrouillèrent automatiquement.
Soudain, le terminal mural s'alluma. Une voix froide et synthétique emplit la pièce :
"PROTOCOLE OMEGA ENGAGÉ. Statut de l'hôte : ÉLIMINÉ. Toutes les issues scellées sous quarantaine absolue pendant 24 heures. Identifiez le tueur parmi vous, ou le coffre du terminal sera purgé."
Les invités se regardèrent les uns les autres dans un silence terrifiant. La tempête au-dehors se déchaînait contre l'acier, mais le vrai danger était assis à table. La quarantaine avait commencé.`;

// Milliseconds "per character" for the typewriter effect. Progress is computed from
// REAL elapsed time (see startIntroTypewriter), not from the number of setInterval
// ticks that fired, since the browser can throttle timers heavily in background tabs.
const TYPING_MS_PER_CHAR = 32;

// How long after the role label appears the role-reveal screen starts fading out,
// and how long that fade lasts — must match the transition below.
const ROLE_REVEAL_HOLD_MS = 5000;
const ROLE_REVEAL_FADE_MS = 1000;

// Fallback grace window (ms) to auto-end the turn after a room has been inspected,
// used only if the server didn't send its own `inspectMs` in 'room_entered' (older
// server). The server's shortened turn timer is authoritative — this local timer
// is purely a UX countdown/backstop, never the real source of truth.
const DEFAULT_ROOM_INSPECT_MS = 4500;

// --- MANSION LAYOUT: must mirror the MANSION structure on the server (same room
// ids), since the server is the source of truth for who is where (fog of war).
// Each room gets its own CSS Grid coordinates (col/row — "start / end" strings),
// so rooms come out different sizes and shapes (square and rectangular, narrow and
// wide) like a real floor plan, instead of a uniform grid of identical cells. Empty
// "technical" columns/rows between blocks of rooms (small fractional tracks) read
// visually as corridors — they're additionally highlighted via corridors[]. Floor 1
// and floor 2 layouts are intentionally different (a symmetric cross of corridors
// with 2x2 blocks on floor 1 vs. two horizontal gallery corridors on floor 2).
const MANSION_LAYOUT = {
  0: {
    // The basement is a single, deliberately oversized room taking up the
    // entire floor — no corridors, nothing else down here. It's the room
    // voted-out players are narratively taken to during a Court/Trial
    // execution, kept purely for atmosphere; it's a perfectly normal,
    // unrestricted room to walk into otherwise (unlike f1_holding_cell).
    columns: '1fr',
    rows: '1fr',
    corridors: [],
    rooms: [
      { id: 'b_torture', name: 'Torture Room', col: '1 / 2', row: '1 / 2' }
    ]
  },
  1: {
    // 8 columns/rows: narrow tracks (0.35fr) at positions 3 and 6 are corridors
    // connecting all three "wings" of the mansion crosswise.
    columns: '1fr 1fr 0.35fr 1fr 1fr 0.35fr 1fr 1fr',
    rows: '1fr 1fr 0.35fr 1fr 1fr 0.35fr 1fr 1fr',
    corridors: [
      { col: '1 / 9', row: '3 / 4' },
      { col: '1 / 9', row: '6 / 7' },
      { col: '3 / 4', row: '1 / 9' },
      { col: '6 / 7', row: '1 / 9' }
    ],
    rooms: [
      { id: 'f1_hall', name: 'Grand Hall', col: '1 / 3', row: '1 / 3' },
      { id: 'f1_library', name: 'Library', col: '4 / 6', row: '1 / 3' },
      { id: 'f1_conservatory', name: 'Conservatory', col: '7 / 9', row: '1 / 3' },
      { id: 'f1_kitchen', name: 'Kitchen', col: '1 / 3', row: '4 / 5' },
      { id: 'f1_dining', name: 'Dining Room', col: '1 / 3', row: '5 / 6' },
      { id: 'f1_study', name: 'Study', col: '4 / 6', row: '4 / 6' },
      { id: 'f1_cellar', name: 'Wine Cellar', col: '7 / 9', row: '4 / 6' },
      { id: 'f1_ballroom', name: 'Ballroom', col: '1 / 3', row: '7 / 9' },
      { id: 'f1_armory', name: 'Armory', col: '4 / 5', row: '7 / 9' },
      { id: 'f1_garage', name: 'Garage', col: '5 / 6', row: '7 / 9' },
      // Free bottom-right corner of floor 1 — the Officer's holding cell for detained suspects.
      { id: 'f1_holding_cell', name: 'Holding Cell', col: '7 / 9', row: '7 / 9' }
    ]
  },
  2: {
    // Different layout: no vertical corridors, instead two wide horizontal gallery
    // corridors splitting the floor into three long tiers of rooms.
    columns: 'repeat(9, 1fr)',
    rows: '1fr 1fr 0.3fr 1fr 1fr 0.3fr 1fr',
    corridors: [
      { col: '1 / 10', row: '3 / 4' },
      { col: '1 / 10', row: '6 / 7' }
    ],
    rooms: [
      { id: 'f2_master', name: 'Master Bedroom', col: '1 / 4', row: '1 / 3' },
      { id: 'f2_bath', name: 'Bathroom', col: '4 / 5', row: '1 / 3' },
      { id: 'f2_guest', name: 'Guest Room', col: '5 / 7', row: '1 / 3' },
      { id: 'f2_nursery', name: 'Nursery', col: '7 / 10', row: '1 / 3' },
      { id: 'f2_office', name: 'Private Office', col: '1 / 3', row: '4 / 6' },
      { id: 'f2_gallery', name: 'Portrait Gallery', col: '3 / 7', row: '4 / 6' },
      { id: 'f2_archive', name: 'Archive', col: '7 / 10', row: '4 / 5' },
      { id: 'f2_terrace', name: 'Terrace', col: '7 / 10', row: '5 / 6' },
      { id: 'f2_attic', name: 'Attic', col: '1 / 5', row: '7 / 8' },
      { id: 'f2_observatory', name: 'Observatory', col: '5 / 10', row: '7 / 8' }
    ]
  }
};

// --- ROOM NAME TRANSLATIONS: the server is only ever aware of the English
// room names (they're the shared identifiers baked into MANSION_LAYOUT and
// echoed back verbatim in every socket event — trap/evidence/body/clue
// payloads, toasts, etc.). This map lets the client re-label any of those
// English strings for display when the Russian UI is active, without
// touching the underlying id/name used for game logic or vent/trap lookups.
const ROOM_NAMES_RU = {
  'Torture Room': 'Пыточная',
  'Grand Hall': 'Главный зал',
  'Library': 'Библиотека',
  'Conservatory': 'Оранжерея',
  'Kitchen': 'Кухня',
  'Dining Room': 'Столовая',
  'Study': 'Кабинет',
  'Wine Cellar': 'Винный погреб',
  'Ballroom': 'Бальный зал',
  'Armory': 'Оружейная',
  'Garage': 'Гараж',
  'Holding Cell': 'Камера содержания',
  'Master Bedroom': 'Хозяйская спальня',
  'Bathroom': 'Ванная комната',
  'Guest Room': 'Гостевая комната',
  'Nursery': 'Детская',
  'Private Office': 'Личный кабинет',
  'Portrait Gallery': 'Портретная галерея',
  'Archive': 'Архив',
  'Terrace': 'Терраса',
  'Attic': 'Чердак',
  'Observatory': 'Обсерватория'
};

const ROOM_NAMES_UK = {
  'Torture Room': 'Катівня',
  'Grand Hall': 'Головна зала',
  'Library': 'Бібліотека',
  'Conservatory': 'Оранжерея',
  'Kitchen': 'Кухня',
  'Dining Room': 'Їдальня',
  'Study': 'Кабінет',
  'Wine Cellar': 'Винний льох',
  'Ballroom': 'Бальна зала',
  'Armory': 'Збройова',
  'Garage': 'Гараж',
  'Holding Cell': 'Камера утримання',
  'Master Bedroom': 'Хазяйська спальня',
  'Bathroom': 'Ванна кімната',
  'Guest Room': 'Гостьова кімната',
  'Nursery': 'Дитяча',
  'Private Office': 'Особистий кабінет',
  'Portrait Gallery': 'Портретна галерея',
  'Archive': 'Архів',
  'Terrace': 'Тераса',
  'Attic': 'Горище',
  'Observatory': 'Обсерваторія'
};

const ROOM_NAMES_ES = {
  'Torture Room': 'Sala de Tortura',
  'Grand Hall': 'Gran Vestíbulo',
  'Library': 'Biblioteca',
  'Conservatory': 'Invernadero',
  'Kitchen': 'Cocina',
  'Dining Room': 'Comedor',
  'Study': 'Despacho',
  'Wine Cellar': 'Bodega de Vinos',
  'Ballroom': 'Salón de Baile',
  'Armory': 'Armería',
  'Garage': 'Garaje',
  'Holding Cell': 'Celda de Retención',
  'Master Bedroom': 'Dormitorio Principal',
  'Bathroom': 'Baño',
  'Guest Room': 'Habitación de Invitados',
  'Nursery': 'Cuarto Infantil',
  'Private Office': 'Oficina Privada',
  'Portrait Gallery': 'Galería de Retratos',
  'Archive': 'Archivo',
  'Terrace': 'Terraza',
  'Attic': 'Ático',
  'Observatory': 'Observatorio'
};

const ROOM_NAMES_DE = {
  'Torture Room': 'Folterkammer',
  'Grand Hall': 'Große Halle',
  'Library': 'Bibliothek',
  'Conservatory': 'Wintergarten',
  'Kitchen': 'Küche',
  'Dining Room': 'Esszimmer',
  'Study': 'Arbeitszimmer',
  'Wine Cellar': 'Weinkeller',
  'Ballroom': 'Ballsaal',
  'Armory': 'Waffenkammer',
  'Garage': 'Garage',
  'Holding Cell': 'Arrestzelle',
  'Master Bedroom': 'Hauptschlafzimmer',
  'Bathroom': 'Badezimmer',
  'Guest Room': 'Gästezimmer',
  'Nursery': 'Kinderzimmer',
  'Private Office': 'Privatbüro',
  'Portrait Gallery': 'Porträtgalerie',
  'Archive': 'Archiv',
  'Terrace': 'Terrasse',
  'Attic': 'Dachboden',
  'Observatory': 'Sternwarte'
};

const ROOM_NAMES_FR = {
  'Torture Room': 'Salle de torture',
  'Grand Hall': 'Grand Hall',
  'Library': 'Bibliothèque',
  'Conservatory': "Jardin d'hiver",
  'Kitchen': 'Cuisine',
  'Dining Room': 'Salle à manger',
  'Study': 'Bureau',
  'Wine Cellar': 'Cave à vin',
  'Ballroom': 'Salle de bal',
  'Armory': 'Armurerie',
  'Garage': 'Garage',
  'Holding Cell': 'Cellule de détention',
  'Master Bedroom': 'Chambre principale',
  'Bathroom': 'Salle de bain',
  'Guest Room': "Chambre d'amis",
  'Nursery': "Chambre d'enfant",
  'Private Office': 'Bureau privé',
  'Portrait Gallery': 'Galerie de portraits',
  'Archive': 'Archives',
  'Terrace': 'Terrasse',
  'Attic': 'Grenier',
  'Observatory': 'Observatoire'
};

// Translates a room name for display only. `name` is whatever English string
// the server/MANSION_LAYOUT gave us; falls back to the original if there's
// no mapping (e.g. an unexpected/legacy value) or the UI isn't in Russian/Ukrainian/Spanish/German/French.
function translateRoomName(name, language) {
  if (!name) return name;
  if (language === 'ru') return ROOM_NAMES_RU[name] || name;
  if (language === 'uk') return ROOM_NAMES_UK[name] || name;
  if (language === 'es') return ROOM_NAMES_ES[name] || name;
  if (language === 'de') return ROOM_NAMES_DE[name] || name;
  if (language === 'fr') return ROOM_NAMES_FR[name] || name;
  return name;
}

// --- EVIDENCE (CLUE) TRANSLATIONS: same situation as ROOM_NAMES_RU above —
// the server (CHARACTER_EVIDENCE) only ever knows the English item name and
// description, and echoes them back verbatim in every socket event that
// touches evidence (investigate_result, joker_evidence_result,
// accomplice_change_evidence's result, verify_evidence_result,
// kill_resolved's killerClue, clues_board_update, trial findings, etc).
// Keyed by the exact English `text` the server sends — every name in
// CHARACTER_EVIDENCE is unique, so this is a safe, stable lookup key. Falls
// back to the server's own string for anything unrecognized (e.g. a future
// item added server-side without an entry added here yet).
const EVIDENCE_RU = {
  'Auction certificate': { name: 'Сертификат с аукциона', description: 'Официальное свидетельство о покупке цифрового произведения искусства на астрономическую сумму, с отметкой о полной оплате.' },
  'Hardware crypto wallet': { name: 'Аппаратный крипто-кошелёк', description: 'Элегантный титановый USB-накопитель лимитированной серии с лазерной гравировкой серийного номера, купленный на элитном техно-аукционе.' },
  'Vintage Swiss watch': { name: 'Винтажные швейцарские часы', description: 'Изящный аксессуар на тонком кожаном ремешке, слегка испачканный каплей дорогого красного вина.' },
  'Watchmaker magnifier': { name: 'Часовая лупа', description: 'Высокоточная ювелирная лупа для осмотра сложных механизмов часов.' },
  'Crystal stopper': { name: 'Хрустальная пробка', description: 'Тяжёлая пробка от редкой винтажной бутылки вина, всё ещё хранящая насыщенный, резкий аромат.' },

  'Steel foil tip cover': { name: 'Стальной наконечник рапиры', description: 'Защитный колпачок для наконечника спортивной рапиры, аккуратно выгравированный инициалами «К.Т.».' },
  'White fencing glove': { name: 'Белая фехтовальная перчатка', description: 'Безупречная кожаная перчатка для фехтования с едва заметными следами мела и вышитой личной эмблемой.' },
  'Opera ticket stub': { name: 'Обгоревший оперный билет', description: 'Обгоревший обрывок VIP-билета на премьеру в первом ряду престижного театра.' },
  'Gold opera glasses': { name: 'Золотой театральный бинокль', description: 'Компактный винтажный латунный бинокль, отделанный перламутром.' },
  'Genealogy chart': { name: 'Генеалогическое древо', description: 'Отрывок из старинной книги о королевских династиях, где одна родовая линия обведена красным маркером.' },

  'Rubber pool duck': { name: 'Резиновая уточка для бассейна', description: 'Детская резиновая игрушка, испачканная тёмным машинным маслом и промышленными отходами.' },
  'Duck feed container': { name: 'Баночка с кормом для уток', description: 'Небольшая металлическая банка с сухой зерновой смесью и мелкими крошками сигарного табака.' },
  'Cigar butt with ash': { name: 'Окурок сигары с пеплом', description: 'Недокуренная импортная сигара с золотым тиснёным кольцом и свежим табачным пеплом.' },
  'Engraved brass Zippo': { name: 'Гравированная латунная зажигалка Zippo', description: 'Тяжёлая старинная зажигалка, сильно пахнущая бензином для зажигалок, с истёртыми инициалами «А.Р.» на боку.' },
  'Garbage contract': { name: 'Мусорный контракт', description: 'Смятый договор на вывоз мусора со смазанной подписью, похожей на «Росси».' },

  'Guitar pick and string': { name: 'Медиатор и струна', description: 'Чёрный медиатор со стилизованным логотипом рядом с оборванной стальной гитарной струной.' },
  'Custom Explorer guitar strap': { name: 'Именной гитарный ремень «Explorer»', description: 'Плотный кожаный ремень с металлическими шипами, слабо пахнущий сценическим дымом.' },
  'Engine oil canister': { name: 'Канистра моторного масла', description: 'Металлическая ёмкость для масла от мощного V8-двигателя с чёткими отпечатками пальцев на боку.' },
  'Greasy shop rag': { name: 'Промасленная тряпка', description: 'Тёмно-красная ткань, пропитанная высокооктановым бензином и густой моторной смазкой.' },
  'Rifle casing': { name: 'Винтовочная гильза', description: 'Стреляная гильза крупного калибра, явно принадлежавшая нарезному охотничьему карабину.' },

  'Exercise band': { name: 'Резинка для тренировок', description: 'Порванный резиновый эспандер с явными следами интенсивных физических нагрузок.' },
  'Chalk dust pouch': { name: 'Мешочек с магнезией', description: 'Небольшой тканевый мешочек с сухим гимнастическим мелом для сухости рук во время тяжёлых тренировок.' },
  'Tattoo sketch': { name: 'Эскиз татуировки', description: 'Мрачный монохромный рисунок, сделанный от руки на смятом листе бумаги.' },
  'Drawing charcoal pencil': { name: 'Угольный карандаш для рисования', description: 'Тонкий чёрный графитовый карандаш, стёртый почти до огрызка от прорисовки сложных татуировок.' },
  'Makeshift shank': { name: 'Самодельная заточка', description: 'Тяжёлый металлический стержень, заточенный до острия, с рукоятью, плотно обмотанной чёрной изолентой.' },

  'Recipe card': { name: 'Рецептурная карточка', description: 'Карточка с домашним рецептом пирога, запятнанная глубоко-красными каплями, подозрительно похожими на кровь.' },
  'Cherry pie tin': { name: 'Форма для вишнёвого пирога', description: 'Лёгкая алюминиевая форма для выпечки с остатками липкого сладкого красного сиропа.' },
  'Skein of wool yarn': { name: 'Моток шерстяной пряжи', description: 'Мягкий клубок толстой пряжи с торчащей из него длинной стальной спицей.' },
  'Stray wool thread': { name: 'Оторванная шерстяная нить', description: 'Длинная нить ярко-вишнёвой пряжи, вытянутая из тяжёлого вязаного свитера ручной работы.' },
  'Paperback novel': { name: 'Потрёпанный детективный роман', description: 'Потрёпанная детективная книга с закладкой, лежащей ровно на главе под названием «Убийца — это...».' },

  'Jar of glowing dust': { name: 'Банка со светящейся пылью', description: 'Стеклянный флакон с фосфоресцирующим порошком и колпачком от засушенного лесного гриба.' },
  'Dried mushroom cap': { name: 'Засушенная шляпка гриба', description: 'Хрупкий биолюминесцентный лесной гриб, слабо светящийся в полной темноте.' },
  'Woven flower crown': { name: 'Плетёный венок из цветов', description: 'Засушенный венок из лесных цветов с кусочками зелёного мха, застрявшими между стеблями.' },
  'Floral wire snips': { name: 'Флористические ножницы', description: 'Крошечные ржавые ножницы для подрезки стеблей цветов и лозы.' },
  'Sparkling dust jar': { name: 'Баночка с блестящей пылью', description: 'Крошечный закупоренный стеклянный флакон с переливающимися блёстками и мелким песком.' },

  'Suture thread': { name: 'Хирургическая нить', description: 'Катушка тонкой хирургической нити, прикреплённая к изогнутой игле на конце.' },
  'Synthetic skin patch': { name: 'Лоскут синтетической кожи', description: 'Резиновая тренировочная подложка с рядом аккуратных, плотных хирургических швов, вызывающих тревогу.' },
  'Surgical scalpel': { name: 'Хирургический скальпель', description: 'Старинный стальной инструмент с бритвенно-острым лезвием, на котором остались едва заметные следы синтетической кожи.' },
  'Antique scalpel case': { name: 'Старинный футляр для скальпелей', description: 'Обитая бархатом деревянная шкатулка, предназначенная для набора исторических хирургических инструментов.' },
  'Anatomy page': { name: 'Страница из атласа анатомии', description: 'Вырванная страница из медицинского учебника с анализом уязвимых точек вдоль сонной артерии.' },

  'Locked black journal': { name: 'Запертый чёрный дневник', description: 'Карманный дневник в твёрдом переплёте, запертый на миниатюрный замочек.' },
  'Water-damaged note': { name: 'Размокшая записка', description: 'Рукописная записка с размытыми водой словами: «...снова один в этой тёмной комнате...».' },
  'Vinyl record sleeve fragment': { name: 'Обрывок конверта виниловой пластинки', description: 'Кусок редкого конверта виниловой пластинки, слабо пахнущий дождём и сыростью.' },
  'Headphone jack adapter': { name: 'Переходник для наушников', description: 'Небольшой позолоченный аудиопереходник с крошечной эмблемой эмо-группы.' },
  'Damp umbrella cover': { name: 'Мокрый чехол от зонта', description: 'Насквозь мокрый нейлоновый чехол для компактного чёрного зонта.' },

  'Charcoal stick': { name: 'Угольный стержень', description: 'Кусок рисовального угля, оставивший тёмную пыль на пальцах после хаотичных набросков на стене.' },
  'Smudged wall rubbing': { name: 'Смазанный оттиск со стены', description: 'Лист бумаги, прижатый к твёрдой поверхности, отпечатавший хаотичные спиралевидные узоры углём.' },
  'Note to invisible visitors': { name: 'Записка невидимым гостям', description: 'Смятый лист бумаги с записью странного рукописного диалога с невидимым собеседником.' },
  'Empty blister pack': { name: 'Пустая блистерная упаковка', description: 'Полностью пустая фольгированная упаковка, ранее содержавшая ярко окрашенные рецептурные таблетки.' },
  'Pill bottle cap': { name: 'Крышка от флакона с таблетками', description: 'Защитная крышка от флакона рецептурных лекарств, испачканная чёрной угольной пылью.' },

  'Katana sheath': { name: 'Ножны катаны', description: 'Кожаные ножны для традиционного японского меча, сильно пахнущие оружейным маслом и полиролью.' },
  'Tsuka-ito ribbon': { name: 'Лента цука-ито', description: 'Полоса прочной, обработанной воском чёрной шёлковой ленты, используемой для обмотки рукояти меча.' },
  'Revenge checklist': { name: 'Список мести', description: 'Лист бумаги со списком имён, где два пункта аккуратно вычеркнуты.' },
  'Crossed-out name fragment': { name: 'Обрывок с вычеркнутым именем', description: 'Оторванный клочок бумаги с именем одной из целей, перечёркнутым жирной красной линией.' },
  'Meditation blindfold': { name: 'Повязка для медитации', description: 'Чёрная шёлковая повязка на голову, всё ещё влажная от пота после изнурительной тренировки.' },

  'Literature club pin': { name: 'Значок литературного клуба', description: 'Металлический значок с изображением книги и выгравированной поэтической цитатой.' },
  'Metaphorical poem draft': { name: 'Черновик метафоричного стихотворения', description: 'Лист бумаги с глубоко личным стихотворением о цифровом одиночестве и классической игре на фортепиано.' },
  'Piano sheet music': { name: 'Ноты для фортепиано', description: 'Страница из тетради с меланхоличной мелодией в минорной тональности, записанной от руки.' },
  'USB drive': { name: 'USB-накопитель', description: 'Компактная флешка с аккуратной наклейкой «script_v2.py».' },
  'Code printout': { name: 'Распечатка кода', description: 'Страница сложного Python-кода с рукописными музыкальными пометками на полях.' },

  'Mysterious personal item': { name: 'Загадочная личная вещь', description: 'Неопознанный предмет без каких-либо дополнительных зацепок.' }
};

const EVIDENCE_UK = {
  'Auction certificate': { name: 'Сертифікат з аукціону', description: "Офіційне свідоцтво про купівлю цифрового витвору мистецтва за астрономічну суму, з відміткою про повну оплату." },
  'Hardware crypto wallet': { name: 'Апаратний крипто-гаманець', description: 'Елегантний титановий USB-накопичувач лімітованої серії з лазерним гравіюванням серійного номера, куплений на елітному техно-аукціоні.' },
  'Vintage Swiss watch': { name: 'Вінтажний швейцарський годинник', description: 'Витончений аксесуар на тонкому шкіряному ремінці, злегка забруднений краплею дорогого червоного вина.' },
  'Watchmaker magnifier': { name: 'Годинникарська лупа', description: 'Високоточна ювелірна лупа для огляду складних механізмів годинників.' },
  'Crystal stopper': { name: 'Кришталева пробка', description: 'Важка пробка від рідкісної вінтажної пляшки вина, що досі зберігає насичений, різкий аромат.' },

  'Steel foil tip cover': { name: 'Сталевий наконечник рапіри', description: 'Захисний ковпачок для наконечника спортивної рапіри, акуратно вигравіюваний ініціалами «К.Т.».' },
  'White fencing glove': { name: 'Біла фехтувальна рукавичка', description: "Бездоганна шкіряна рукавичка для фехтування з ледь помітними слідами крейди та вишитою особистою емблемою." },
  'Opera ticket stub': { name: 'Обгорілий оперний квиток', description: "Обгорілий уривок VIP-квитка на прем'єру в першому ряду престижного театру." },
  'Gold opera glasses': { name: 'Золотий театральний бінокль', description: 'Компактний вінтажний латунний бінокль, оздоблений перламутром.' },
  'Genealogy chart': { name: 'Генеалогічне дерево', description: 'Уривок зі старовинної книги про королівські династії, де один родовід обведено червоним маркером.' },

  'Rubber pool duck': { name: 'Гумове каченя для басейну', description: 'Дитяча гумова іграшка, забруднена темним машинним мастилом і промисловими відходами.' },
  'Duck feed container': { name: 'Баночка з кормом для качок', description: 'Невелика металева банка із сухою зерновою сумішшю та дрібними крихтами сигарного тютюну.' },
  'Cigar butt with ash': { name: 'Недопалок сигари з попелом', description: 'Недопалена імпортна сигара із золотим тисненим кільцем і свіжим тютюновим попелом.' },
  'Engraved brass Zippo': { name: 'Гравійована латунна запальничка Zippo', description: 'Важка старовинна запальничка, що сильно пахне бензином для запальничок, зі стертими ініціалами «А.Р.» на боці.' },
  'Garbage contract': { name: 'Сміттєвий контракт', description: "Зім'ятий договір на вивезення сміття зі змазаним підписом, схожим на «Россі»." },

  'Guitar pick and string': { name: 'Медіатор і струна', description: 'Чорний медіатор зі стилізованим логотипом поруч з обірваною сталевою гітарною струною.' },
  'Custom Explorer guitar strap': { name: 'Іменний гітарний ремінь «Explorer»', description: 'Щільний шкіряний ремінь з металевими шипами, що ледь чутно пахне сценічним димом.' },
  'Engine oil canister': { name: 'Каністра моторної оливи', description: 'Металева ємність для оливи від потужного V8-двигуна з чіткими відбитками пальців на боці.' },
  'Greasy shop rag': { name: 'Промащена ганчірка', description: 'Темно-червона тканина, просякнута високооктановим бензином і густим моторним мастилом.' },
  'Rifle casing': { name: 'Гвинтівкова гільза', description: 'Стріляна гільза великого калібру, що явно належала нарізному мисливському карабіну.' },

  'Exercise band': { name: 'Гумка для тренувань', description: 'Порваний гумовий еспандер з явними слідами інтенсивних фізичних навантажень.' },
  'Chalk dust pouch': { name: 'Мішечок з магнезією', description: 'Невеликий тканинний мішечок із сухою гімнастичною крейдою для сухості рук під час важких тренувань.' },
  'Tattoo sketch': { name: 'Ескіз татуювання', description: "Похмурий монохромний малюнок, зроблений від руки на зім'ятому аркуші паперу." },
  'Drawing charcoal pencil': { name: 'Вугільний олівець для малювання', description: "Тонкий чорний графітовий олівець, стертий майже до недогризка від промальовування складних татуювань." },
  'Makeshift shank': { name: 'Саморобна заточка', description: "Важкий металевий стрижень, загострений до вістря, з руків'ям, щільно обмотаним чорною ізолентою." },

  'Recipe card': { name: 'Рецептурна картка', description: 'Картка з домашнім рецептом пирога, заплямована глибоко-червоними краплями, підозріло схожими на кров.' },
  'Cherry pie tin': { name: 'Форма для вишневого пирога', description: "Легка алюмінієва форма для випічки із залишками липкого солодкого червоного сиропу." },
  'Skein of wool yarn': { name: 'Моток вовняної пряжі', description: "М'який клубок товстої пряжі з довгою стальною спицею, що стирчить з нього." },
  'Stray wool thread': { name: 'Обірвана вовняна нитка', description: "Довга нитка яскраво-вишневої пряжі, витягнута з важкого в'язаного светра ручної роботи." },
  'Paperback novel': { name: 'Потріпаний детективний роман', description: 'Потріпана детективна книга із закладкою, що лежить рівно на розділі під назвою «Убивця — це...».' },

  'Jar of glowing dust': { name: 'Банка зі світною пилюкою', description: 'Скляний флакон із фосфоресцентним порошком і кришечкою від засушеного лісового гриба.' },
  'Dried mushroom cap': { name: 'Засушена шляпка гриба', description: 'Крихкий біолюмінесцентний лісовий гриб, що слабко світиться в повній темряві.' },
  'Woven flower crown': { name: 'Плетений вінок із квітів', description: 'Засушений вінок із лісових квітів зі шматочками зеленого моху, застряглими між стеблами.' },
  'Floral wire snips': { name: 'Флористичні ножиці', description: 'Крихітні іржаві ножиці для підрізання стебел квітів і лози.' },
  'Sparkling dust jar': { name: 'Баночка з блискучим пилом', description: 'Крихітний закупорений скляний флакон з переливчастими блискітками та дрібним піском.' },

  'Suture thread': { name: 'Хірургічна нитка', description: 'Котушка тонкої хірургічної нитки, прикріплена до вигнутої голки на кінці.' },
  'Synthetic skin patch': { name: 'Клапоть синтетичної шкіри', description: 'Гумова тренувальна підкладка з рядом акуратних, щільних хірургічних швів, що викликають тривогу.' },
  'Surgical scalpel': { name: 'Хірургічний скальпель', description: 'Старовинний сталевий інструмент з бритвено-гострим лезом, на якому залишилися ледь помітні сліди синтетичної шкіри.' },
  'Antique scalpel case': { name: 'Старовинний футляр для скальпелів', description: "Оббита оксамитом дерев'яна скринька, призначена для набору історичних хірургічних інструментів." },
  'Anatomy page': { name: 'Сторінка з атласу анатомії', description: 'Вирвана сторінка з медичного підручника з аналізом вразливих точок уздовж сонної артерії.' },

  'Locked black journal': { name: 'Замкнений чорний щоденник', description: 'Кишеньковий щоденник у твердій палітурці, замкнений на мініатюрний замочок.' },
  'Water-damaged note': { name: 'Розмокла записка', description: 'Рукописна записка з розмитими водою словами: «...знову сам у цій темній кімнаті...».' },
  'Vinyl record sleeve fragment': { name: 'Уривок конверта вінілової платівки', description: 'Шматок рідкісного конверта вінілової платівки, що ледь пахне дощем і вологістю.' },
  'Headphone jack adapter': { name: 'Перехідник для навушників', description: 'Невеликий позолочений аудіоперехідник з крихітною емблемою емо-гурту.' },
  'Damp umbrella cover': { name: 'Мокрий чохол від парасольки', description: 'Наскрізь мокрий нейлоновий чохол для компактної чорної парасольки.' },

  'Charcoal stick': { name: 'Вугільний стрижень', description: 'Шматок малювального вугілля, що залишив темний пил на пальцях після хаотичних начерків на стіні.' },
  'Smudged wall rubbing': { name: 'Змазаний відбиток зі стіни', description: 'Аркуш паперу, притиснутий до твердої поверхні, що відбив хаотичні спіралеподібні візерунки вугіллям.' },
  'Note to invisible visitors': { name: 'Записка невидимим гостям', description: "Зім'ятий аркуш паперу із записом дивного рукописного діалогу з невидимим співрозмовником." },
  'Empty blister pack': { name: 'Порожня блістерна упаковка', description: 'Повністю порожня фольгована упаковка, що раніше містила яскраво забарвлені рецептурні таблетки.' },
  'Pill bottle cap': { name: 'Кришка від флакона з таблетками', description: 'Захисна кришка від флакона рецептурних ліків, забруднена чорним вугільним пилом.' },

  'Katana sheath': { name: 'Піхви катани', description: 'Шкіряні піхви для традиційного японського меча, що сильно пахнуть зброярською олією та поліроллю.' },
  'Tsuka-ito ribbon': { name: 'Стрічка цука-іто', description: "Смуга міцної, обробленої воском чорної шовкової стрічки, що використовується для обмотування руків'я меча." },
  'Revenge checklist': { name: 'Список помсти', description: 'Аркуш паперу зі списком імен, де два пункти акуратно викреслено.' },
  'Crossed-out name fragment': { name: "Уривок із закресленим ім'ям", description: 'Обірваний клаптик паперу з іменем однієї з цілей, перекресленим жирною червоною лінією.' },
  'Meditation blindfold': { name: "Пов'язка для медитації", description: "Чорна шовкова пов'язка на голову, досі волога від поту після виснажливого тренування." },

  'Literature club pin': { name: 'Значок літературного клубу', description: 'Металевий значок із зображенням книги та вигравіюваною поетичною цитатою.' },
  'Metaphorical poem draft': { name: 'Чернетка метафоричного вірша', description: 'Аркуш паперу з глибоко особистим віршем про цифрову самотність і класичну гру на фортепіано.' },
  'Piano sheet music': { name: 'Ноти для фортепіано', description: 'Сторінка із зошита з меланхолійною мелодією в мінорній тональності, записаною від руки.' },
  'USB drive': { name: 'USB-накопичувач', description: 'Компактна флешка з акуратною наклейкою «script_v2.py».' },
  'Code printout': { name: 'Роздруківка коду', description: 'Сторінка складного Python-коду з рукописними музичними позначками на полях.' },

  'Mysterious personal item': { name: 'Загадкова особиста річ', description: 'Неідентифікований предмет без будь-яких додаткових зачіпок.' }
};

const EVIDENCE_ES = {
  'Auction certificate': { name: 'Certificado de subasta', description: 'Prueba oficial de compra de una obra de arte digital por una suma astronómica, con sello de pago íntegro.' },
  'Hardware crypto wallet': { name: 'Monedero cripto de hardware', description: 'Elegante memoria USB de titanio de edición limitada con grabado láser del número de serie, comprada en una subasta tecnológica de élite.' },
  'Vintage Swiss watch': { name: 'Reloj suizo vintage', description: 'Accesorio elegante con correa de cuero fina, ligeramente manchado con una gota de vino tinto caro.' },
  'Watchmaker magnifier': { name: 'Lupa de relojero', description: 'Lupa de joyero de alta precisión para examinar mecanismos de relojería complejos.' },
  'Crystal stopper': { name: 'Tapón de cristal', description: 'Tapón pesado de una rara botella de vino vintage, que aún conserva un aroma intenso y penetrante.' },

  'Steel foil tip cover': { name: 'Funda de punta de florete de acero', description: 'Tapa protectora para la punta de un florete deportivo, grabada cuidadosamente con las iniciales «K.T.».' },
  'White fencing glove': { name: 'Guante blanco de esgrima', description: 'Guante de esgrima de cuero impecable con leves rastros de tiza y un emblema personal bordado.' },
  'Opera ticket stub': { name: 'Talón de entrada de ópera quemado', description: 'Fragmento quemado de una entrada VIP para el estreno en primera fila de un teatro prestigioso.' },
  'Gold opera glasses': { name: 'Gemelos de teatro dorados', description: 'Prismáticos vintage compactos de latón, con acabado de nácar.' },
  'Genealogy chart': { name: 'Árbol genealógico', description: 'Fragmento de un antiguo libro sobre dinastías reales, con una línea familiar marcada en rojo.' },

  'Rubber pool duck': { name: 'Pato de goma de piscina', description: 'Juguete de goma infantil manchado con aceite de motor oscuro y residuos industriales.' },
  'Duck feed container': { name: 'Bote de comida para patos', description: 'Pequeña lata metálica con mezcla seca de granos y pequeñas migas de tabaco de puro.' },
  'Cigar butt with ash': { name: 'Colilla de puro con ceniza', description: 'Puro importado a medio fumar con un anillo dorado grabado y ceniza de tabaco fresca.' },
  'Engraved brass Zippo': { name: 'Encendedor Zippo de latón grabado', description: 'Encendedor antiguo pesado, con fuerte olor a gasolina de encendedor, con las iniciales «A.R.» desgastadas en el costado.' },
  'Garbage contract': { name: 'Contrato de basura', description: 'Contrato arrugado de recolección de basura con una firma borrosa que parece decir «Rossi».' },

  'Guitar pick and string': { name: 'Púa y cuerda de guitarra', description: 'Púa negra con un logo estilizado junto a una cuerda de guitarra de acero rota.' },
  'Custom Explorer guitar strap': { name: 'Correa de guitarra personalizada «Explorer»', description: 'Correa de cuero grueso con tachuelas metálicas, con un ligero olor a humo de escenario.' },
  'Engine oil canister': { name: 'Bidón de aceite de motor', description: 'Recipiente metálico de aceite para un potente motor V8, con huellas dactilares claras en el costado.' },
  'Greasy shop rag': { name: 'Trapo de taller grasiento', description: 'Tela rojo oscuro empapada de gasolina de alto octanaje y lubricante espeso de motor.' },
  'Rifle casing': { name: 'Casquillo de rifle', description: 'Casquillo percutido de gran calibre, perteneciente claramente a un rifle de caza estriado.' },

  'Exercise band': { name: 'Banda elástica de ejercicio', description: 'Banda elástica rota con claros signos de entrenamiento físico intenso.' },
  'Chalk dust pouch': { name: 'Bolsa de polvo de magnesia', description: 'Pequeña bolsa de tela con tiza de gimnasia seca para mantener las manos secas durante entrenamientos duros.' },
  'Tattoo sketch': { name: 'Boceto de tatuaje', description: 'Dibujo monocromático sombrío, hecho a mano en una hoja de papel arrugada.' },
  'Drawing charcoal pencil': { name: 'Lápiz de carboncillo para dibujo', description: 'Lápiz de grafito negro fino, gastado casi hasta el final de tanto dibujar tatuajes complejos.' },
  'Makeshift shank': { name: 'Punzón improvisado', description: 'Varilla metálica pesada, afilada hasta la punta, con el mango firmemente envuelto en cinta aislante negra.' },

  'Recipe card': { name: 'Tarjeta de receta', description: 'Tarjeta con una receta casera de tarta, manchada con gotas de un rojo profundo sospechosamente parecidas a sangre.' },
  'Cherry pie tin': { name: 'Molde de tarta de cereza', description: 'Molde de aluminio ligero para hornear con restos de sirope rojo dulce y pegajoso.' },
  'Skein of wool yarn': { name: 'Madeja de lana', description: 'Ovillo suave de lana gruesa con una larga aguja de acero clavada.' },
  'Stray wool thread': { name: 'Hilo de lana suelto', description: 'Hilo largo de lana rojo cereza vivo, extraído de un pesado suéter tejido a mano.' },
  'Paperback novel': { name: 'Novela de bolsillo desgastada', description: 'Libro de detectives desgastado con un marcapáginas justo en el capítulo titulado «El asesino es...».' },

  'Jar of glowing dust': { name: 'Frasco de polvo brillante', description: 'Frasco de vidrio con polvo fosforescente y una tapa hecha de un hongo forestal seco.' },
  'Dried mushroom cap': { name: 'Sombrero de hongo seco', description: 'Frágil hongo forestal bioluminiscente, que brilla débilmente en la oscuridad total.' },
  'Woven flower crown': { name: 'Corona de flores tejida', description: 'Corona seca de flores silvestres con trozos de musgo verde atrapados entre los tallos.' },
  'Floral wire snips': { name: 'Tijeras de floristería', description: 'Diminutas tijeras oxidadas para cortar tallos de flores y enredaderas.' },
  'Sparkling dust jar': { name: 'Frasco de polvo reluciente', description: 'Diminuto frasco de vidrio sellado con purpurina reluciente y arena fina.' },

  'Suture thread': { name: 'Hilo de sutura', description: 'Carrete de hilo quirúrgico fino, sujeto a una aguja curva en el extremo.' },
  'Synthetic skin patch': { name: 'Parche de piel sintética', description: 'Base de entrenamiento de goma con una hilera de puntos quirúrgicos pulcros y apretados, inquietante.' },
  'Surgical scalpel': { name: 'Bisturí quirúrgico', description: 'Instrumento antiguo de acero con hoja afilada como navaja, con rastros apenas visibles de piel sintética.' },
  'Antique scalpel case': { name: 'Estuche antiguo para bisturís', description: 'Caja de madera forrada en terciopelo, diseñada para un juego de instrumentos quirúrgicos históricos.' },
  'Anatomy page': { name: 'Página de atlas de anatomía', description: 'Página arrancada de un libro de texto médico con un análisis de los puntos vulnerables a lo largo de la arteria carótida.' },

  'Locked black journal': { name: 'Diario negro cerrado con llave', description: 'Diario de bolsillo de tapa dura, cerrado con un pequeño candado.' },
  'Water-damaged note': { name: 'Nota dañada por el agua', description: 'Nota manuscrita con palabras borrosas por el agua: «...otra vez solo en esta habitación oscura...».' },
  'Vinyl record sleeve fragment': { name: 'Fragmento de funda de vinilo', description: 'Trozo de una funda de vinilo poco común, con un leve olor a lluvia y humedad.' },
  'Headphone jack adapter': { name: 'Adaptador de conector de auriculares', description: 'Pequeño adaptador de audio bañado en oro con un diminuto emblema de una banda emo.' },
  'Damp umbrella cover': { name: 'Funda húmeda de paraguas', description: 'Funda de nailon completamente empapada para un paraguas negro compacto.' },

  'Charcoal stick': { name: 'Barra de carboncillo', description: 'Trozo de carboncillo de dibujo que dejó polvo oscuro en los dedos tras bocetos caóticos en la pared.' },
  'Smudged wall rubbing': { name: 'Frotado borroso de pared', description: 'Hoja de papel presionada contra una superficie dura, que imprimió patrones caóticos en espiral con carboncillo.' },
  'Note to invisible visitors': { name: 'Nota a visitantes invisibles', description: 'Hoja de papel arrugada con un extraño diálogo manuscrito dirigido a un interlocutor invisible.' },
  'Empty blister pack': { name: 'Blíster vacío', description: 'Envase de aluminio completamente vacío que antes contenía pastillas recetadas de colores brillantes.' },
  'Pill bottle cap': { name: 'Tapa de frasco de pastillas', description: 'Tapa protectora de un frasco de medicamentos recetados, manchada con polvo de carboncillo negro.' },

  'Katana sheath': { name: 'Vaina de katana', description: 'Vaina de cuero para una espada tradicional japonesa, con fuerte olor a aceite de armas y abrillantador.' },
  'Tsuka-ito ribbon': { name: 'Cinta tsuka-ito', description: 'Tira de cinta de seda negra resistente y encerada, usada para envolver la empuñadura de una espada.' },
  'Revenge checklist': { name: 'Lista de venganza', description: 'Hoja de papel con una lista de nombres, con dos elementos tachados cuidadosamente.' },
  'Crossed-out name fragment': { name: 'Fragmento con nombre tachado', description: 'Trozo de papel roto con el nombre de uno de los objetivos, tachado con una gruesa línea roja.' },
  'Meditation blindfold': { name: 'Venda de meditación', description: 'Venda de seda negra, todavía húmeda de sudor tras un entrenamiento agotador.' },

  'Literature club pin': { name: 'Pin del club de literatura', description: 'Pin metálico con la imagen de un libro y una cita poética grabada.' },
  'Metaphorical poem draft': { name: 'Borrador de poema metafórico', description: 'Hoja de papel con un poema profundamente personal sobre la soledad digital y el piano clásico.' },
  'Piano sheet music': { name: 'Partitura de piano', description: 'Página de un cuaderno con una melodía melancólica en tono menor, escrita a mano.' },
  'USB drive': { name: 'Memoria USB', description: 'Pendrive compacto con una etiqueta prolija que dice «script_v2.py».' },
  'Code printout': { name: 'Impresión de código', description: 'Página de código Python complejo con anotaciones musicales manuscritas en los márgenes.' },

  'Mysterious personal item': { name: 'Objeto personal misterioso', description: 'Objeto no identificado sin ninguna pista adicional.' }
};

const EVIDENCE_DE = {
  'Auction certificate': { name: 'Auktionszertifikat', description: 'Offizieller Kaufnachweis für ein digitales Kunstwerk über eine astronomische Summe, mit Vermerk der vollständigen Zahlung.' },
  'Hardware crypto wallet': { name: 'Hardware-Krypto-Wallet', description: 'Elegantes Titan-USB-Laufwerk einer limitierten Serie mit lasergravierter Seriennummer, gekauft bei einer exklusiven Technik-Auktion.' },
  'Vintage Swiss watch': { name: 'Vintage-Schweizer-Uhr', description: 'Elegantes Accessoire an einem dünnen Lederarmband, leicht befleckt mit einem Tropfen teuren Rotweins.' },
  'Watchmaker magnifier': { name: 'Uhrmacherlupe', description: 'Hochpräzise Juwelierlupe zur Untersuchung komplexer Uhrwerke.' },
  'Crystal stopper': { name: 'Kristallstöpsel', description: 'Schwerer Stöpsel aus einer seltenen Vintage-Weinflasche, der noch immer ein intensives, scharfes Aroma trägt.' },

  'Steel foil tip cover': { name: 'Stahlspitzenkappe für Florett', description: 'Schutzkappe für die Spitze eines Sportfloretts, sorgfältig mit den Initialen „K.T.“ graviert.' },
  'White fencing glove': { name: 'Weißer Fechthandschuh', description: 'Makelloser Lederhandschuh zum Fechten mit kaum sichtbaren Kreidespuren und einem gestickten persönlichen Emblem.' },
  'Opera ticket stub': { name: 'Verbrannter Opernticket-Abschnitt', description: 'Verbrannter Rest eines VIP-Tickets für die Premiere in der ersten Reihe eines renommierten Theaters.' },
  'Gold opera glasses': { name: 'Goldenes Opernglas', description: 'Kompaktes Vintage-Opernglas aus Messing mit Perlmutt-Verzierung.' },
  'Genealogy chart': { name: 'Stammbaum', description: 'Ausschnitt aus einem alten Buch über königliche Dynastien, in dem eine Linie rot markiert ist.' },

  'Rubber pool duck': { name: 'Gummiente für den Pool', description: 'Kinderspielzeug aus Gummi, verschmutzt mit dunklem Motoröl und Industrieabfällen.' },
  'Duck feed container': { name: 'Dose mit Entenfutter', description: 'Kleine Metalldose mit trockener Körnermischung und feinen Zigarrentabakkrümeln.' },
  'Cigar butt with ash': { name: 'Zigarrenstummel mit Asche', description: 'Halb gerauchte Importzigarre mit goldgeprägtem Ring und frischer Tabakasche.' },
  'Engraved brass Zippo': { name: 'Gravierte Messing-Zippo', description: 'Schweres altes Feuerzeug, das stark nach Feuerzeugbenzin riecht, mit abgenutzten Initialen „A.R.“ an der Seite.' },
  'Garbage contract': { name: 'Müllvertrag', description: 'Zerknitterter Müllabfuhrvertrag mit einer verwischten Unterschrift, die wie „Rossi“ aussieht.' },

  'Guitar pick and string': { name: 'Plektrum und Gitarrensaite', description: 'Schwarzes Plektrum mit stilisiertem Logo neben einer gerissenen Stahl-Gitarrensaite.' },
  'Custom Explorer guitar strap': { name: 'Individueller Gitarrengurt „Explorer“', description: 'Fester Ledergurt mit Metallnieten, der schwach nach Bühnennebel riecht.' },
  'Engine oil canister': { name: 'Motoröl-Kanister', description: 'Metallbehälter für Öl eines starken V8-Motors mit deutlichen Fingerabdrücken an der Seite.' },
  'Greasy shop rag': { name: 'Öliger Werkstattlappen', description: 'Dunkelrotes Tuch, getränkt mit hochoktanigem Benzin und dickem Motorenfett.' },
  'Rifle casing': { name: 'Gewehrpatronenhülse', description: 'Verschossene großkalibrige Hülse, die eindeutig von einem gezogenen Jagdgewehr stammt.' },

  'Exercise band': { name: 'Fitnessband', description: 'Gerissenes Gummi-Fitnessband mit deutlichen Spuren intensiven Trainings.' },
  'Chalk dust pouch': { name: 'Magnesiabeutel', description: 'Kleiner Stoffbeutel mit trockener Turnkreide, um die Hände bei hartem Training trocken zu halten.' },
  'Tattoo sketch': { name: 'Tattoo-Skizze', description: 'Düstere monochrome Zeichnung, von Hand auf ein zerknittertes Blatt Papier gebracht.' },
  'Drawing charcoal pencil': { name: 'Kohlestift zum Zeichnen', description: 'Dünner schwarzer Grafitstift, fast bis zum Stummel abgenutzt vom Zeichnen komplexer Tattoos.' },
  'Makeshift shank': { name: 'Behelfsmäßige Stichwaffe', description: 'Schwerer Metallstab, bis zur Spitze angeschliffen, mit einem Griff, der fest mit schwarzem Isolierband umwickelt ist.' },

  'Recipe card': { name: 'Rezeptkarte', description: 'Karte mit einem hausgemachten Kuchenrezept, befleckt mit tiefroten Tropfen, die verdächtig nach Blut aussehen.' },
  'Cherry pie tin': { name: 'Kirschkuchenform', description: 'Leichte Aluminium-Backform mit Resten von klebrigem, süßem rotem Sirup.' },
  'Skein of wool yarn': { name: 'Wollknäuel', description: 'Weicher Knäuel dicker Wolle mit einer langen Stahlnadel, die daraus hervorsteht.' },
  'Stray wool thread': { name: 'Verirrter Wollfaden', description: 'Langer Faden kirschroter Wolle, herausgezogen aus einem schweren handgestrickten Pullover.' },
  'Paperback novel': { name: 'Zerlesener Kriminalroman', description: 'Zerlesenes Krimibuch mit einem Lesezeichen genau bei dem Kapitel mit dem Titel „Der Mörder ist...“.' },

  'Jar of glowing dust': { name: 'Glas mit leuchtendem Staub', description: 'Glasfläschchen mit phosphoreszierendem Pulver und einem Deckel von einem getrockneten Waldpilz.' },
  'Dried mushroom cap': { name: 'Getrockneter Pilzhut', description: 'Zerbrechlicher biolumineszenter Waldpilz, der im Dunkeln schwach leuchtet.' },
  'Woven flower crown': { name: 'Geflochtener Blumenkranz', description: 'Getrockneter Kranz aus Waldblumen mit Stückchen grünen Mooses zwischen den Stängeln.' },
  'Floral wire snips': { name: 'Blumendraht-Schere', description: 'Winzige rostige Schere zum Schneiden von Blumenstielen und Ranken.' },
  'Sparkling dust jar': { name: 'Glas mit funkelndem Staub', description: 'Winziges verschlossenes Glasfläschchen mit schimmerndem Glitzer und feinem Sand.' },

  'Suture thread': { name: 'Nahtmaterial', description: 'Spule aus feinem chirurgischem Faden, an dessen Ende eine gebogene Nadel befestigt ist.' },
  'Synthetic skin patch': { name: 'Kunsthaut-Fleck', description: 'Gummi-Übungsunterlage mit einer Reihe ordentlicher, dichter chirurgischer Nähte, die beunruhigend wirken.' },
  'Surgical scalpel': { name: 'Chirurgisches Skalpell', description: 'Altes Stahlinstrument mit rasiermesserscharfer Klinge, an der kaum sichtbare Spuren von Kunsthaut haften.' },
  'Antique scalpel case': { name: 'Antikes Skalpell-Etui', description: 'Mit Samt ausgekleidete Holzschatulle für ein Set historischer chirurgischer Instrumente.' },
  'Anatomy page': { name: 'Seite aus einem Anatomieatlas', description: 'Herausgerissene Seite aus einem medizinischen Lehrbuch mit einer Analyse der verwundbaren Stellen entlang der Halsschlagader.' },

  'Locked black journal': { name: 'Verschlossenes schwarzes Tagebuch', description: 'Gebundenes Taschentagebuch, verschlossen mit einem winzigen Schloss.' },
  'Water-damaged note': { name: 'Wasserbeschädigte Notiz', description: 'Handgeschriebene Notiz mit vom Wasser verwischten Worten: „...wieder allein in diesem dunklen Zimmer...“.' },
  'Vinyl record sleeve fragment': { name: 'Fragment einer Schallplattenhülle', description: 'Stück einer seltenen Schallplattenhülle, das schwach nach Regen und Feuchtigkeit riecht.' },
  'Headphone jack adapter': { name: 'Kopfhörer-Adapter', description: 'Kleiner vergoldeter Audioadapter mit einem winzigen Emblem einer Emo-Band.' },
  'Damp umbrella cover': { name: 'Feuchte Regenschirmhülle', description: 'Vollkommen durchnässte Nylonhülle für einen kompakten schwarzen Regenschirm.' },

  'Charcoal stick': { name: 'Kohlestift', description: 'Stück Zeichenkohle, das nach chaotischen Skizzen an der Wand dunklen Staub an den Fingern hinterlassen hat.' },
  'Smudged wall rubbing': { name: 'Verwischter Wandabdruck', description: 'Blatt Papier, das gegen eine harte Oberfläche gepresst wurde und chaotische spiralförmige Muster in Kohle abbildet.' },
  'Note to invisible visitors': { name: 'Notiz an unsichtbare Besucher', description: 'Zerknittertes Blatt Papier mit einem seltsamen handgeschriebenen Dialog an einen unsichtbaren Gesprächspartner.' },
  'Empty blister pack': { name: 'Leere Blisterpackung', description: 'Vollständig leere Folienverpackung, die zuvor grell gefärbte verschreibungspflichtige Tabletten enthielt.' },
  'Pill bottle cap': { name: 'Deckel einer Tablettenflasche', description: 'Schutzdeckel einer Flasche verschreibungspflichtiger Medikamente, verschmutzt mit schwarzem Kohlestaub.' },

  'Katana sheath': { name: 'Katana-Scheide', description: 'Lederscheide für ein traditionelles japanisches Schwert, die stark nach Waffenöl und Politur riecht.' },
  'Tsuka-ito ribbon': { name: 'Tsuka-Ito-Band', description: 'Streifen aus robustem, gewachstem schwarzem Seidenband, das zum Umwickeln eines Schwertgriffs verwendet wird.' },
  'Revenge checklist': { name: 'Racheliste', description: 'Blatt Papier mit einer Namensliste, auf der zwei Punkte sauber durchgestrichen sind.' },
  'Crossed-out name fragment': { name: 'Fragment mit durchgestrichenem Namen', description: 'Abgerissener Papierfetzen mit dem Namen eines der Ziele, durchgestrichen mit einer dicken roten Linie.' },
  'Meditation blindfold': { name: 'Meditations-Augenbinde', description: 'Schwarze Seiden-Augenbinde, noch feucht vom Schweiß nach einem anstrengenden Training.' },

  'Literature club pin': { name: 'Anstecker des Literaturclubs', description: 'Metallanstecker mit dem Bild eines Buches und einem eingravierten poetischen Zitat.' },
  'Metaphorical poem draft': { name: 'Entwurf eines metaphorischen Gedichts', description: 'Blatt Papier mit einem zutiefst persönlichen Gedicht über digitale Einsamkeit und klassisches Klavierspiel.' },
  'Piano sheet music': { name: 'Klaviernoten', description: 'Seite aus einem Notizbuch mit einer melancholischen Melodie in Moll, handschriftlich notiert.' },
  'USB drive': { name: 'USB-Stick', description: 'Kompakter USB-Stick mit einem ordentlichen Aufkleber „script_v2.py“.' },
  'Code printout': { name: 'Code-Ausdruck', description: 'Seite mit komplexem Python-Code und handschriftlichen musikalischen Notizen am Rand.' },

  'Mysterious personal item': { name: 'Mysteriöser persönlicher Gegenstand', description: 'Nicht identifiziertes Objekt ohne weitere Hinweise.' }
};

const EVIDENCE_FR = {
  'Auction certificate': { name: "Certificat d'enchère", description: "Preuve d'achat officielle d'une œuvre d'art numérique pour une somme astronomique, avec mention du paiement intégral." },
  'Hardware crypto wallet': { name: 'Portefeuille crypto matériel', description: "Élégante clé USB en titane, série limitée, gravée au laser avec un numéro de série, achetée lors d'une vente aux enchères technologique select." },
  'Vintage Swiss watch': { name: 'Montre suisse vintage', description: 'Accessoire élégant sur un bracelet en cuir fin, légèrement taché par une goutte de vin rouge coûteux.' },
  'Watchmaker magnifier': { name: "Loupe d'horloger", description: "Loupe de joaillier de haute précision pour examiner des mécanismes d'horlogerie complexes." },
  'Crystal stopper': { name: 'Bouchon en cristal', description: "Lourd bouchon d'une rare bouteille de vin vintage, qui conserve encore un arôme intense et âpre." },

  'Steel foil tip cover': { name: 'Protège-pointe de fleuret en acier', description: "Capuchon de protection pour la pointe d'un fleuret de sport, soigneusement gravé des initiales « K.T. »." },
  'White fencing glove': { name: "Gant d'escrime blanc", description: "Gant en cuir impeccable pour l'escrime, avec de légères traces de craie et un emblème personnel brodé." },
  'Opera ticket stub': { name: "Talon de billet d'opéra brûlé", description: "Fragment brûlé d'un billet VIP pour la première au premier rang d'un théâtre prestigieux." },
  'Gold opera glasses': { name: 'Jumelles de théâtre dorées', description: 'Jumelles vintage compactes en laiton, ornées de nacre.' },
  'Genealogy chart': { name: 'Arbre généalogique', description: "Extrait d'un vieux livre sur les dynasties royales, où une lignée est entourée au marqueur rouge." },

  'Rubber pool duck': { name: 'Canard en caoutchouc pour piscine', description: "Jouet en caoutchouc pour enfant, taché d'huile moteur sombre et de déchets industriels." },
  'Duck feed container': { name: 'Boîte de nourriture pour canards', description: 'Petite boîte métallique contenant un mélange de grains secs et de fines miettes de tabac à cigare.' },
  'Cigar butt with ash': { name: 'Mégot de cigare avec cendres', description: "Cigare d'importation à moitié fumé, avec une bague dorée gaufrée et de la cendre de tabac fraîche." },
  'Engraved brass Zippo': { name: 'Zippo en laiton gravé', description: "Lourd briquet ancien, à l'odeur forte d'essence à briquet, avec les initiales usées « A.R. » sur le côté." },
  'Garbage contract': { name: 'Contrat de ramassage des ordures', description: "Contrat froissé pour l'enlèvement des ordures, avec une signature maculée ressemblant à « Rossi »." },

  'Guitar pick and string': { name: 'Médiator et corde de guitare', description: "Médiator noir au logo stylisé à côté d'une corde de guitare en acier cassée." },
  'Custom Explorer guitar strap': { name: 'Sangle de guitare personnalisée « Explorer »', description: 'Sangle en cuir épais avec des clous métalliques, qui sent faiblement la fumée de scène.' },
  'Engine oil canister': { name: "Bidon d'huile moteur", description: "Récipient métallique pour l'huile d'un puissant moteur V8, avec des empreintes digitales nettes sur le côté." },
  'Greasy shop rag': { name: "Chiffon d'atelier graisseux", description: "Tissu rouge foncé, imbibé d'essence à haut indice d'octane et de graisse moteur épaisse." },
  'Rifle casing': { name: 'Douille de fusil', description: 'Douille de gros calibre, appartenant clairement à une carabine de chasse rayée.' },

  'Exercise band': { name: 'Bande élastique de fitness', description: "Bande élastique déchirée, portant des traces évidentes d'un entraînement intensif." },
  'Chalk dust pouch': { name: 'Sachet de magnésie', description: 'Petit sachet en tissu contenant de la craie de gymnastique sèche, pour garder les mains sèches pendant un entraînement intense.' },
  'Tattoo sketch': { name: 'Croquis de tatouage', description: 'Dessin monochrome sombre, réalisé à la main sur une feuille de papier froissée.' },
  'Drawing charcoal pencil': { name: 'Crayon fusain de dessin', description: "Fin crayon graphite noir, usé presque jusqu'au bout à force de dessiner des tatouages complexes." },
  'Makeshift shank': { name: 'Lame de fortune', description: 'Lourde tige métallique, aiguisée en pointe, avec une poignée solidement enroulée de ruban isolant noir.' },

  'Recipe card': { name: 'Fiche de recette', description: 'Fiche avec une recette de tarte maison, tachée de gouttes rouge foncé qui ressemblent étrangement à du sang.' },
  'Cherry pie tin': { name: 'Moule à tarte aux cerises', description: 'Moule à pâtisserie léger en aluminium, avec des restes de sirop rouge sucré et collant.' },
  'Skein of wool yarn': { name: 'Écheveau de laine', description: "Pelote souple de laine épaisse, avec une longue aiguille en acier qui en dépasse." },
  'Stray wool thread': { name: 'Fil de laine égaré', description: "Long fil de laine rouge cerise vif, tiré d'un lourd pull tricoté à la main." },
  'Paperback novel': { name: 'Roman policier écorné', description: 'Livre policier écorné, avec un marque-page posé exactement au chapitre intitulé « Le meurtrier est... ».' },

  'Jar of glowing dust': { name: 'Bocal de poussière lumineuse', description: "Flacon en verre contenant une poudre phosphorescente et un bouchon provenant d'un champignon séché." },
  'Dried mushroom cap': { name: 'Chapeau de champignon séché', description: "Champignon forestier bioluminescent et fragile, qui luit faiblement dans l'obscurité totale." },
  'Woven flower crown': { name: 'Couronne de fleurs tressée', description: 'Couronne séchée de fleurs des bois, avec des morceaux de mousse verte coincés entre les tiges.' },
  'Floral wire snips': { name: 'Sécateur de fleuriste', description: 'Minuscules ciseaux rouillés pour couper les tiges de fleurs et de lianes.' },
  'Sparkling dust jar': { name: 'Bocal de poussière scintillante', description: 'Minuscule flacon en verre bouché, rempli de paillettes irisées et de sable fin.' },

  'Suture thread': { name: 'Fil de suture', description: "Bobine de fil chirurgical fin, avec une aiguille courbée fixée à son extrémité." },
  'Synthetic skin patch': { name: 'Patch de peau synthétique', description: "Support d'entraînement en caoutchouc, marqué d'une rangée de points de suture chirurgicaux nets et serrés, ce qui est inquiétant." },
  'Surgical scalpel': { name: 'Scalpel chirurgical', description: "Instrument en acier ancien à la lame tranchante comme un rasoir, portant des traces à peine visibles de peau synthétique." },
  'Antique scalpel case': { name: 'Étui à scalpels ancien', description: "Coffret en bois tapissé de velours, destiné à un ensemble d'instruments chirurgicaux historiques." },
  'Anatomy page': { name: "Page d'un atlas d'anatomie", description: "Page arrachée d'un manuel de médecine, analysant les points vulnérables le long de l'artère carotide." },

  'Locked black journal': { name: 'Journal noir verrouillé', description: 'Journal intime relié, verrouillé par un petit cadenas.' },
  'Water-damaged note': { name: "Note endommagée par l'eau", description: "Note manuscrite aux mots effacés par l'eau : « ...encore seul dans cette pièce sombre... »." },
  'Vinyl record sleeve fragment': { name: 'Fragment de pochette de vinyle', description: "Morceau de pochette de disque vinyle rare, qui sent faiblement la pluie et l'humidité." },
  'Headphone jack adapter': { name: 'Adaptateur jack pour écouteurs', description: "Petit adaptateur audio doré, orné d'un minuscule emblème de groupe emo." },
  'Damp umbrella cover': { name: 'Housse de parapluie humide', description: 'Housse en nylon complètement trempée pour un parapluie noir compact.' },

  'Charcoal stick': { name: 'Bâton de fusain', description: 'Morceau de fusain à dessin, qui a laissé de la poussière sombre sur les doigts après des croquis chaotiques sur le mur.' },
  'Smudged wall rubbing': { name: 'Frottis de mur estompé', description: "Feuille de papier pressée contre une surface dure, imprimant des motifs spiralés chaotiques au fusain." },
  'Note to invisible visitors': { name: 'Note à des visiteurs invisibles', description: 'Feuille de papier froissée avec un étrange dialogue manuscrit adressé à un interlocuteur invisible.' },
  'Empty blister pack': { name: 'Plaquette de médicaments vide', description: "Emballage en aluminium entièrement vide, qui contenait auparavant des comprimés sur ordonnance aux couleurs vives." },
  'Pill bottle cap': { name: 'Bouchon de flacon de médicaments', description: "Bouchon protecteur d'un flacon de médicaments sur ordonnance, taché de poussière de fusain noire." },

  'Katana sheath': { name: 'Fourreau de katana', description: "Fourreau en cuir pour une épée japonaise traditionnelle, dégageant une forte odeur d'huile d'arme et de polish." },
  'Tsuka-ito ribbon': { name: 'Ruban tsuka-ito', description: "Bande de ruban en soie noire solide et cirée, utilisée pour enrouler la poignée d'une épée." },
  'Revenge checklist': { name: 'Liste de vengeance', description: 'Feuille de papier avec une liste de noms, dont deux éléments soigneusement rayés.' },
  'Crossed-out name fragment': { name: 'Fragment avec un nom barré', description: "Bout de papier déchiré portant le nom d'une des cibles, barré d'un épais trait rouge." },
  'Meditation blindfold': { name: 'Bandeau de méditation', description: "Bandeau en soie noire, encore humide de sueur après un entraînement épuisant." },

  'Literature club pin': { name: 'Épinglette du club de littérature', description: 'Épinglette métallique représentant un livre, avec une citation poétique gravée.' },
  'Metaphorical poem draft': { name: 'Brouillon de poème métaphorique', description: 'Feuille de papier avec un poème profondément personnel sur la solitude numérique et le piano classique.' },
  'Piano sheet music': { name: 'Partition de piano', description: "Page d'un cahier avec une mélodie mélancolique en tonalité mineure, notée à la main." },
  'USB drive': { name: 'Clé USB', description: 'Clé USB compacte portant une étiquette soignée « script_v2.py ».' },
  'Code printout': { name: 'Impression de code', description: 'Page de code Python complexe avec des annotations musicales manuscrites dans la marge.' },

  'Mysterious personal item': { name: 'Objet personnel mystérieux', description: 'Objet non identifié, sans indice supplémentaire.' }
};

// Evidence item NAME for display — falls back to the raw server string for
// anything unrecognized or when the UI isn't Russian/Ukrainian/Spanish/German/French.
function translateEvidenceName(text, language) {
  if (!text) return text;
  if (language === 'ru') return EVIDENCE_RU[text]?.name || text;
  if (language === 'uk') return EVIDENCE_UK[text]?.name || text;
  if (language === 'es') return EVIDENCE_ES[text]?.name || text;
  if (language === 'de') return EVIDENCE_DE[text]?.name || text;
  if (language === 'fr') return EVIDENCE_FR[text]?.name || text;
  return text;
}

// Evidence item DESCRIPTION for display — keyed off the item's (untranslated)
// `text`, since that's the stable id shared with EVIDENCE_RU/EVIDENCE_UK above.
// Falls back to whatever description string the server actually sent.
function translateEvidenceDescription(text, description, language) {
  if (language === 'ru') return EVIDENCE_RU[text]?.description || description;
  if (language === 'uk') return EVIDENCE_UK[text]?.description || description;
  if (language === 'es') return EVIDENCE_ES[text]?.description || description;
  if (language === 'de') return EVIDENCE_DE[text]?.description || description;
  if (language === 'fr') return EVIDENCE_FR[text]?.description || description;
  return description;
}

// --- BODY (VICTIM SCENE) DESCRIPTIONS: same idea, but keyed by character
// name (BODY_DESCRIPTIONS server-side) rather than by evidence text, since
// that's the stable field the findings/body payloads already carry.
const BODY_DESCRIPTIONS_RU = {
  Creed: 'Тело Крида застыло на полу в изящной позе, из кармана выпали разбитые дорогие часы. Тонкая струйка крови стекает из уголка рта, резко контрастируя с его безупречным костюмом.',
  Karl: 'Карл лежит лицом вниз, его рука крепко сжимает наконечник фехтовальной рапиры. Тёмная засохшая кровь пятнает его безупречный белый воротник.',
  Anthonio: 'Массивное тело Антонио тяжело лежит на боку, рядом всё ещё тлеет дорогая сигара. Его глаза широко открыты — застывший тихий шок от внезапной смерти.',
  James: 'Джеймс привалился к стене, будто отброшенный мощным ударом, в нескольких шагах лежит его чёрный медиатор. Кровь медленно сочится из тяжёлой раны на груди.',
  Cedric: 'Закалённое в боях тело Седрика застыло в оборонительной позе, хотя следы борьбы указывают на трусливую засаду из-за угла. На его татуированных руках видны свежие ссадины.',
  Lidy: 'Хрупкое тело Лиди выглядит беспомощным, вокруг разбросаны мотки шерстяной пряжи. Её лицо застыло в выражении глубокого страха и предательства.',
  May: 'Маленькая Мэй лежит неподвижно, вокруг рассыпан светящийся порошок из разбитой стеклянной банки. Её плетёный цветочный венок сбит набок и частично примят.',
  Gregory: 'Доктор Чен упал навзничь, хирургические инструменты высыпались из открытой медицинской сумки. Точный, профессиональный удар лишил его жизни за считаные секунды.',
  Onyx: 'Тело Оникса неподвижно лежит в тени, почти сливаясь с ней, его запертый чёрный дневник отброшен в сторону. На мокром полу рядом видны следы недолгой борьбы.',
  Max: 'Макс застыл в неестественной позе у стены, покрытой его хаотичными угольными набросками. Вокруг рассыпаны яркие таблетки из вскрытой блистерной упаковки.',
  Bea: 'Беа лежит у противоположной стены, её рука всё ещё сжимает ножны катаны, которую она так и не успела обнажить. В её остекленевших глазах застыла чистая ярость от несбывшейся мести.',
  Moonka: 'Мунка неподвижно лежит на полу, сжимая в руке маленькую флешку с кодом. Её лицо на удивление умиротворено — будто она успела дописать своё последнее стихотворение перед концом.'
};

const BODY_DESCRIPTIONS_UK = {
  Creed: 'Тіло Кріда застигло на підлозі у вишуканій позі, з кишені випав розбитий дорогий годинник. Тонка цівка крові стікає з кутика рота, різко контрастуючи з його бездоганним костюмом.',
  Karl: 'Карл лежить обличчям униз, його рука міцно стискає наконечник фехтувальної рапіри. Темна засохла кров плямує його бездоганний білий комір.',
  Anthonio: 'Масивне тіло Антоніо важко лежить на боці, поруч ще тліє дорога сигара. Його очі широко розплющені — застиглий тихий шок від раптової смерті.',
  James: "Джеймс притулився до стіни, наче відкинутий потужним ударом, за кілька кроків лежить його чорний медіатор. Кров повільно сочиться з важкої рани на грудях.",
  Cedric: 'Загартоване в боях тіло Седріка застигло в оборонній позі, хоча сліди боротьби вказують на боягузливу засідку з-за рогу. На його татуйованих руках видно свіжі садна.',
  Lidy: "Тендітне тіло Ліді виглядає безпорадним, навколо розкидані моти вовняної пряжі. Її обличчя застигло у виразі глибокого страху та зради.",
  May: "Маленька Мей лежить нерухомо, навколо розсипаний світний порошок з розбитої скляної банки. Її плетений квітковий вінок збитий набік і частково зім'ятий.",
  Gregory: 'Доктор Чен впав навзнак, хірургічні інструменти висипалися з відкритої медичної сумки. Точний, професійний удар позбавив його життя за лічені секунди.',
  Onyx: 'Тіло Онікса нерухомо лежить у тіні, майже зливаючись з нею, його замкнений чорний щоденник відкинутий убік. На мокрій підлозі поруч видно сліди недовгої боротьби.',
  Max: 'Макс застиг у неприродній позі біля стіни, вкритої його хаотичними вугільними начерками. Навколо розсипані яскраві таблетки з розкритої блістерної упаковки.',
  Bea: 'Беа лежить біля протилежної стіни, її рука досі стискає піхви катани, яку вона так і не встигла оголити. У її склянистих очах застигла чиста лють від нездійсненної помсти.',
  Moonka: 'Мунка нерухомо лежить на підлозі, стискаючи в руці маленьку флешку з кодом. Її обличчя напрочуд умиротворене — ніби вона встигла дописати свій останній вірш перед кінцем.'
};

const BODY_DESCRIPTIONS_ES = {
  Creed: 'El cuerpo de Creed yace inmóvil en el suelo en una pose elegante, un reloj de lujo roto cayó de su bolsillo. Un fino hilo de sangre le baja por la comisura de la boca, en marcado contraste con su traje impecable.',
  Karl: 'Karl yace boca abajo, su mano aferra con fuerza la punta de un florete de esgrima. Sangre oscura y seca mancha su impecable cuello blanco.',
  Anthonio: 'El corpulento cuerpo de Anthonio yace pesadamente de lado, junto a él aún humea un puro caro. Sus ojos están muy abiertos, en un silencioso shock congelado por la muerte repentina.',
  James: 'James está apoyado contra la pared, como si un golpe potente lo hubiera lanzado, a pocos pasos yace su púa de guitarra negra. La sangre gotea lentamente de una herida profunda en el pecho.',
  Cedric: 'El cuerpo curtido en batallas de Cedric quedó congelado en una postura defensiva, aunque las señales de lucha apuntan a una emboscada cobarde desde una esquina. Sus brazos tatuados muestran rasguños recientes.',
  Lidy: 'El frágil cuerpo de Lidy parece indefenso, con madejas de lana esparcidas alrededor. Su rostro quedó congelado en una expresión de profundo miedo y traición.',
  May: 'La pequeña May yace inmóvil, con polvo brillante esparcido de un frasco de vidrio roto. Su corona de flores tejida está torcida y parcialmente aplastada.',
  Gregory: 'El Dr. Chen cayó de espaldas, instrumentos quirúrgicos derramados de un maletín médico abierto. Un golpe preciso y profesional le quitó la vida en cuestión de segundos.',
  Onyx: 'El cuerpo de Onyx yace inmóvil en la sombra, casi fundido con ella, su diario negro cerrado con llave descartado a un lado. En el suelo húmedo cercano se ven señales de una breve lucha.',
  Max: 'Max quedó congelado en una postura antinatural junto a una pared cubierta de sus dibujos caóticos de carboncillo. Alrededor hay pastillas de colores esparcidas de un blíster abierto.',
  Bea: 'Bea yace junto a la pared opuesta, su mano aún aferra la vaina de la katana que nunca llegó a desenvainar. En sus ojos vidriosos quedó congelada la pura furia de una venganza inconclusa.',
  Moonka: 'Moonka yace inmóvil en el suelo, sosteniendo en la mano una pequeña memoria USB con código. Su rostro está sorprendentemente en paz, como si hubiera alcanzado a terminar su último poema antes del final.'
};

const BODY_DESCRIPTIONS_DE = {
  Creed: 'Creeds Körper liegt in einer eleganten Pose reglos auf dem Boden, eine zerbrochene Luxusuhr ist aus seiner Tasche gefallen. Ein dünner Blutfaden läuft ihm aus dem Mundwinkel, ein starker Kontrast zu seinem makellosen Anzug.',
  Karl: 'Karl liegt mit dem Gesicht nach unten, seine Hand umklammert fest die Spitze eines Fechtdegens. Dunkles, getrocknetes Blut befleckt seinen makellosen weißen Kragen.',
  Anthonio: 'Anthonios massiger Körper liegt schwer auf der Seite, neben ihm qualmt noch eine teure Zigarre. Seine Augen sind weit aufgerissen — ein erstarrter, stiller Schock über den plötzlichen Tod.',
  James: 'James lehnt an der Wand, als hätte ihn ein wuchtiger Schlag dorthin geworfen, wenige Schritte entfernt liegt sein schwarzes Plektrum. Blut tropft langsam aus einer tiefen Wunde in der Brust.',
  Cedric: 'Cedrics kampferprobter Körper ist in einer Verteidigungshaltung erstarrt, obwohl die Kampfspuren auf einen feigen Hinterhalt aus einer Ecke hindeuten. Auf seinen tätowierten Armen sind frische Schürfwunden zu sehen.',
  Lidy: 'Lidys zerbrechlicher Körper wirkt hilflos, ringsum liegen Knäuel Wollgarn verstreut. Ihr Gesicht ist in einem Ausdruck tiefer Angst und Verrats erstarrt.',
  May: 'Die kleine May liegt reglos da, ringsum verstreut liegt glitzerndes Pulver aus einem zerbrochenen Glasgefäß. Ihr geflochtener Blumenkranz ist verrutscht und teilweise zerdrückt.',
  Gregory: 'Dr. Chen fiel rückwärts, chirurgische Instrumente sind aus einer geöffneten Arzttasche verstreut. Ein präziser, professioneller Schlag beendete sein Leben innerhalb weniger Sekunden.',
  Onyx: "Onyx' Körper liegt reglos im Schatten, fast mit ihm verschmolzen, sein verschlossenes schwarzes Tagebuch liegt achtlos zur Seite geworfen. Auf dem feuchten Boden in der Nähe sind Spuren eines kurzen Kampfes zu erkennen.",
  Max: 'Max ist in einer unnatürlichen Haltung an einer Wand erstarrt, die mit seinen chaotischen Kohleskizzen bedeckt ist. Ringsum liegen bunte Tabletten aus einer aufgerissenen Blisterpackung verstreut.',
  Bea: 'Bea liegt an der gegenüberliegenden Wand, ihre Hand umklammert noch immer die Scheide der Katana, die sie nie mehr ziehen konnte. In ihren glasigen Augen ist die pure Wut über eine unvollendete Rache erstarrt.',
  Moonka: 'Moonka liegt reglos auf dem Boden und hält in der Hand einen kleinen USB-Stick mit Code. Ihr Gesicht wirkt überraschend friedlich — als hätte sie gerade noch ihr letztes Gedicht vor dem Ende zu Ende geschrieben.'
};

const BODY_DESCRIPTIONS_FR = {
  Creed: 'Le corps de Creed gît immobile sur le sol dans une pose élégante, une montre de luxe brisée est tombée de sa poche. Un mince filet de sang coule au coin de sa bouche, contrastant fortement avec son costume impeccable.',
  Karl: "Karl gît face contre terre, sa main serre fermement la pointe d'un fleuret d'escrime. Du sang sombre et séché tache son col blanc impeccable.",
  Anthonio: "Le corps massif d'Anthonio repose lourdement sur le côté, un cigare coûteux fume encore à côté de lui. Ses yeux sont grands ouverts, figés dans un choc silencieux face à une mort soudaine.",
  James: 'James est appuyé contre le mur, comme projeté là par un coup puissant, à quelques pas gît son médiator noir. Le sang goutte lentement d\'une profonde blessure à la poitrine.',
  Cedric: "Le corps aguerri de Cedric s'est figé dans une posture défensive, bien que les traces de lutte indiquent une embuscade lâche depuis un coin. Ses bras tatoués portent des égratignures fraîches.",
  Lidy: 'Le corps fragile de Lidy semble sans défense, entouré de pelotes de laine éparpillées. Son visage est figé dans une expression de peur profonde et de trahison.',
  May: "La petite May gît immobile, entourée de poussière brillante répandue d'un bocal en verre brisé. Sa couronne de fleurs tressée est de travers et partiellement écrasée.",
  Gregory: "Le Dr Chen est tombé à la renverse, des instruments chirurgicaux répandus d'une sacoche médicale ouverte. Un coup précis et professionnel lui a ôté la vie en quelques secondes.",
  Onyx: "Le corps d'Onyx gît immobile dans l'ombre, presque fondu avec elle, son journal noir verrouillé jeté de côté. Sur le sol humide à proximité, on distingue des traces d'une brève lutte.",
  Max: 'Max s\'est figé dans une posture contre nature près d\'un mur couvert de ses croquis chaotiques au fusain. Autour de lui sont éparpillés des comprimés colorés d\'une plaquette éventrée.',
  Bea: "Bea gît près du mur opposé, sa main serre encore le fourreau du katana qu'elle n'a jamais eu le temps de dégainer. Dans ses yeux vitreux s'est figée la pure fureur d'une vengeance inachevée.",
  Moonka: "Moonka gît immobile sur le sol, tenant dans sa main une petite clé USB avec du code. Son visage est étonnamment paisible — comme si elle avait eu le temps de terminer son dernier poème avant la fin."
};

// Victim scene description for display — keyed by `character` (e.g. from
// the findings/body payload), falling back to whatever description string
// the server actually sent (covers the 'Mysterious...'-style generic
// fallback the server uses when `character` is missing).
function translateBodyDescription(character, description, language) {
  if (language === 'ru') return BODY_DESCRIPTIONS_RU[character] || description;
  if (language === 'uk') return BODY_DESCRIPTIONS_UK[character] || description;
  if (language === 'es') return BODY_DESCRIPTIONS_ES[character] || description;
  if (language === 'de') return BODY_DESCRIPTIONS_DE[character] || description;
  if (language === 'fr') return BODY_DESCRIPTIONS_FR[character] || description;
  return description;
}

// --- CHARACTER HOBBIES: shown in the trial-phase "DATABASE DOSSIER" panel
// (see CHARACTERS[].hobbies). Keyed by character name, same as
// BODY_DESCRIPTIONS_RU above — CHARACTERS itself stays English-only since
// `realName`/`height`/`weight`/`bloodType` are names/units that don't need
// translation; only the free-text `hobbies` line does.
const HOBBIES_RU = {
  Creed: 'Участвует в аукционах цифрового искусства на миллионы долларов, коллекционирует винтажные люксовые часы, пьёт редкие красные вина.',
  Karl: 'Занимается классическим фехтованием на именных стальных рапирах, посещает премьеры большой оперы, изучает генеалогию королевских династий.',
  Anthonio: 'Кормит диких уток в своём бассейне, курит дорогие импортные сигары, управляет контрактами на вывоз мусора.',
  James: 'Рубит тяжёлые металлические риффы на именной чёрной гитаре Explorer, реставрирует винтажные маслкары с двигателем V8, коллекционирует охотничьи винтовки.',
  Cedric: 'Тренируется по тюремной системе воркаута, рисует эскизы монохромных татуировок, мастерит самодельные инструменты из металлолома.',
  Lidy: 'Печёт домашние вишнёвые пироги, вяжет шерстяные свитера, читает детективные романы в мягкой обложке.',
  May: 'Собирает светящиеся биолюминесцентные лесные грибы, плетёт венки из цветов, собирает блестящую пыльцу в маленькие стеклянные баночки.',
  Gregory: 'Тренирует микрошвы на синтетической коже, коллекционирует исторические хирургические скальпели, изучает судебно-медицинскую анатомию человека.',
  Onyx: 'Пишет меланхоличные стихи в запертом чёрном дневнике, коллекционирует виниловые пластинки midwest emo, любит бывать в одиночестве в тёмных дождливых местах.',
  Max: 'Рисует углём хаотичные повторяющиеся узоры на стенах, разговаривает с невидимыми гостями, копит разноцветные рецептурные таблетки.',
  Bea: 'Отрабатывает удары мечом с настоящей японской катаной, ведёт личный рукописный список мести, практикует интенсивную медитацию боевых искусств.',
  Moonka: 'Пишет глубокие метафоричные стихи для литературного клуба, играет грустные классические мелодии на пианино, пишет программный код.'
};

const HOBBIES_UK = {
  Creed: "Бере участь в аукціонах цифрового мистецтва на мільйони доларів, колекціонує вінтажні люксові годинники, п'є рідкісні червоні вина.",
  Karl: "Займається класичним фехтуванням на іменних сталевих рапірах, відвідує прем'єри великої опери, вивчає генеалогію королівських династій.",
  Anthonio: 'Годує диких качок у своєму басейні, курить дорогі імпортні сигари, керує контрактами на вивезення сміття.',
  James: 'Грає важкі металеві рифи на іменній чорній гітарі Explorer, реставрує вінтажні маслкари з двигуном V8, колекціонує мисливські гвинтівки.',
  Cedric: 'Тренується за тюремною системою воркауту, малює ескізи монохромних татуювань, майструє саморобні інструменти з металобрухту.',
  Lidy: "Пече домашні вишневі пироги, в'яже вовняні светри, читає детективні романи в м'якій обкладинці.",
  May: 'Збирає світні біолюмінесцентні лісові гриби, плете вінки з квітів, збирає блискучий пилок у маленькі скляні баночки.',
  Gregory: 'Тренує мікрошви на синтетичній шкірі, колекціонує історичні хірургічні скальпелі, вивчає судово-медичну анатомію людини.',
  Onyx: 'Пише меланхолійні вірші в замкненому чорному щоденнику, колекціонує вінілові платівки midwest emo, любить бувати наодинці в темних дощових місцях.',
  Max: 'Малює вугіллям хаотичні візерунки, що повторюються, на стінах, розмовляє з невидимими гостями, накопичує різнокольорові рецептурні таблетки.',
  Bea: 'Відпрацьовує удари мечем зі справжньою японською катаною, веде особистий рукописний список помсти, практикує інтенсивну медитацію бойових мистецтв.',
  Moonka: 'Пише глибокі метафоричні вірші для літературного клубу, грає сумні класичні мелодії на піаніно, пише програмний код.'
};

const HOBBIES_ES = {
  Creed: 'Puja en subastas de arte digital por millones de dólares, colecciona relojes de lujo vintage, bebe vinos tintos raros.',
  Karl: 'Practica esgrima clásica con floretes de acero personalizados, asiste a estrenos de gran ópera, estudia la genealogía de las familias reales.',
  Anthonio: 'Alimenta patos salvajes en su piscina, fuma puros importados caros, gestiona contratos de recolección de basura.',
  James: 'Toca riffs pesados de metal en una guitarra Explorer negra personalizada, restaura autos clásicos V8 de época, colecciona rifles de caza.',
  Cedric: 'Entrena calistenia intensa al estilo carcelario, dibuja bocetos de tatuajes monocromáticos, talla herramientas improvisadas con chatarra.',
  Lidy: 'Hornea tartas de cereza caseras, teje suéteres de lana, lee novelas de detectives de bolsillo.',
  May: 'Recolecta hongos bioluminiscentes brillantes del bosque, teje coronas de flores, guarda polvo brillante en pequeños frascos de vidrio.',
  Gregory: 'Practica microsuturas en piel sintética, colecciona bisturís quirúrgicos históricos, estudia anatomía humana forense.',
  Onyx: 'Escribe poesía melancólica en un diario negro cerrado con llave, colecciona vinilos de midwest emo, disfruta estar solo en lugares oscuros y lluviosos.',
  Max: 'Dibuja patrones caóticos y repetitivos en las paredes con carboncillo, habla con visitantes invisibles, acumula pastillas recetadas de colores.',
  Bea: 'Entrena golpes de espada con una katana japonesa auténtica, lleva una lista de venganza personal escrita a mano, practica meditación intensa de artes marciales.',
  Moonka: 'Escribe poemas profundamente metafóricos para un club de literatura, toca melodías clásicas tristes al piano, escribe código de programación.'
};

const HOBBIES_DE = {
  Creed: 'Bietet bei Auktionen für digitale Kunst um Millionen von Dollar, sammelt Vintage-Luxusuhren, trinkt seltene Rotweine.',
  Karl: 'Betreibt klassisches Fechten mit personalisierten Stahlrapieren, besucht Premieren der großen Oper, erforscht die Genealogie königlicher Dynastien.',
  Anthonio: 'Füttert wilde Enten in seinem Swimmingpool, raucht teure Importzigarren, verwaltet Müllabfuhrverträge.',
  James: 'Spielt schwere Metal-Riffs auf einer personalisierten schwarzen Explorer-Gitarre, restauriert klassische V8-Muscle-Cars, sammelt Jagdgewehre.',
  Cedric: 'Trainiert nach dem Gefängnis-Calisthenics-System, entwirft Skizzen für monochrome Tätowierungen, fertigt improvisierte Werkzeuge aus Schrott.',
  Lidy: 'Backt hausgemachte Kirschkuchen, strickt Wollpullover, liest Taschenbuch-Krimis.',
  May: 'Sammelt leuchtende, biolumineszente Waldpilze, flicht Blumenkränze, bewahrt glitzernden Staub in kleinen Glasfläschchen auf.',
  Gregory: 'Übt Mikronähte an synthetischer Haut, sammelt historische chirurgische Skalpelle, studiert forensische Anatomie des Menschen.',
  Onyx: 'Schreibt melancholische Gedichte in ein verschlossenes schwarzes Tagebuch, sammelt Midwest-Emo-Schallplatten, genießt es, allein an dunklen, verregneten Orten zu sein.',
  Max: 'Zeichnet mit Kohle chaotische, sich wiederholende Muster an Wände, spricht mit unsichtbaren Gästen, hortet bunte verschreibungspflichtige Tabletten.',
  Bea: 'Übt Schwerthiebe mit einer echten japanischen Katana, führt eine handschriftliche persönliche Racheliste, praktiziert intensive Kampfkunst-Meditation.',
  Moonka: 'Schreibt tiefgründige, metaphernreiche Gedichte für einen Literaturclub, spielt traurige klassische Melodien am Klavier, schreibt Programmcode.'
};

const HOBBIES_FR = {
  Creed: "Enchérit sur des œuvres d'art numérique pour des millions de dollars, collectionne des montres de luxe vintage, boit des vins rouges rares.",
  Karl: "Pratique l'escrime classique avec des fleurets en acier personnalisés, assiste aux premières du grand opéra, étudie la généalogie des dynasties royales.",
  Anthonio: 'Nourrit des canards sauvages dans sa piscine, fume des cigares d\'importation coûteux, gère des contrats de ramassage des ordures.',
  James: 'Joue des riffs de métal lourds sur une guitare Explorer noire personnalisée, restaure des muscle cars vintage à moteur V8, collectionne des fusils de chasse.',
  Cedric: "S'entraîne selon le système de callisthénie carcérale, dessine des croquis de tatouages monochromes, fabrique des outils de fortune à partir de ferraille.",
  Lidy: 'Fait des tartes aux cerises maison, tricote des pulls en laine, lit des romans policiers de poche.',
  May: 'Ramasse des champignons bioluminescents des bois, tresse des couronnes de fleurs, conserve de la poussière scintillante dans de petits bocaux en verre.',
  Gregory: "S'entraîne aux microsutures sur peau synthétique, collectionne des scalpels chirurgicaux historiques, étudie l'anatomie médico-légale humaine.",
  Onyx: 'Écrit de la poésie mélancolique dans un journal noir verrouillé, collectionne des vinyles de midwest emo, aime être seul dans des endroits sombres et pluvieux.',
  Max: 'Dessine au fusain des motifs chaotiques et répétitifs sur les murs, parle à des visiteurs invisibles, accumule des comprimés sur ordonnance de toutes les couleurs.',
  Bea: "S'entraîne aux coups d'épée avec un authentique katana japonais, tient une liste de vengeance manuscrite personnelle, pratique une méditation intense d'arts martiaux.",
  Moonka: 'Écrit des poèmes profondément métaphoriques pour un club de littérature, joue des mélodies classiques tristes au piano, écrit du code de programmation.'
};

// Character hobbies line for display — keyed by CHARACTERS[].name, falling
// back to the raw English string for anything unrecognized.
function translateHobbies(characterName, hobbies, language) {
  if (language === 'ru') return HOBBIES_RU[characterName] || hobbies;
  if (language === 'uk') return HOBBIES_UK[characterName] || hobbies;
  if (language === 'es') return HOBBIES_ES[characterName] || hobbies;
  if (language === 'de') return HOBBIES_DE[characterName] || hobbies;
  if (language === 'fr') return HOBBIES_FR[characterName] || hobbies;
  return hobbies;
}

// --- TRIAL / GAME-OVER MESSAGE TRANSLATIONS: like translateRoomName above,
// the server only ever sends English prose for these (see 'trial_result',
// 'game_over' and 'code_submission_result' on the backend). Rather than
// hard-code a Russian string builder that has to mirror the server's exact
// interpolation, each server payload also carries a stable `reason` code
// (and, where a name needs to be interpolated, structured data like
// `targetName` / `triggeredBy.nickname`) that these functions key off of.
// Falls back to the server's own `message` for any reason we don't
// recognize (e.g. a legacy/unexpected value) or when the UI isn't Russian.

// Trial council vote outcome — rendered under the trial's code terminal.
function translateTrialResultMessage(result, language) {
  if (!result) return '';
  if (language === 'ru') {
    switch (result.reason) {
      case 'skipped':
        return 'ГОЛОСОВАНИЕ ПРОПУЩЕНО — АГЕНТ НЕ УСТРАНЁН';
      case 'executed':
        return `${result.targetName} устранён(а) по решению совета.`;
      default:
        return result.message;
    }
  }
  if (language === 'uk') {
    switch (result.reason) {
      case 'skipped':
        return 'ГОЛОСУВАННЯ ПРОПУЩЕНО — АГЕНТА НЕ УСУНЕНО';
      case 'executed':
        return `${result.targetName} усунений(а) за рішенням ради.`;
      default:
        return result.message;
    }
  }
  if (language === 'es') {
    switch (result.reason) {
      case 'skipped':
        return 'VOTACIÓN OMITIDA — AGENTE NO ELIMINADO';
      case 'executed':
        return `${result.targetName} fue eliminado(a) por decisión del consejo.`;
      default:
        return result.message;
    }
  }
  if (language === 'de') {
    switch (result.reason) {
      case 'skipped':
        return 'ABSTIMMUNG ÜBERSPRUNGEN — AGENT NICHT AUSGESCHALTET';
      case 'executed':
        return `${result.targetName} wurde durch Ratsbeschluss ausgeschaltet.`;
      default:
        return result.message;
    }
  }
  if (language === 'fr') {
    switch (result.reason) {
      case 'skipped':
        return 'VOTE PASSÉ — AUCUN AGENT ÉLIMINÉ';
      case 'executed':
        return `${result.targetName} a été éliminé(e) par décision du conseil.`;
      default:
        return result.message;
    }
  }
  return result.message;
}

// GAME_OVER summary overlay's victory explanation line.
function translateGameOverMessage(data, language) {
  if (!data) return '';
  const name = data.triggeredBy?.nickname;
  if (language === 'ru') {
    switch (data.reason) {
      case 'joker_executed':
        return `${name} оказался(-ась) Джокером и был(а) казнён(а) по решению совета. Джокер побеждает!`;
      case 'killer_executed':
        return `${name} оказался(-ась) Убийцей и был(а) казнён(а) по решению совета. Невинные побеждают!`;
      case 'killer_majority_wipeout':
        return 'Все мирные агенты устранены. Убийца побеждает!';
      case 'killer_majority_outnumbered':
        return 'Команда Убийцы теперь равна или превосходит числом оставшихся мирных агентов. Убийца побеждает!';
      case 'killer_team_disconnected':
        return 'Убийца выбыл из матча. Невинные побеждают!';
      case 'CODE_CRACKED':
        return `${name} взломал(а) код отмены. Невинные побеждают!`;
      default:
        return data.message;
    }
  }
  if (language === 'uk') {
    switch (data.reason) {
      case 'joker_executed':
        return `${name} виявився(-лася) Джокером і був(ла) страчений(а) за рішенням ради. Джокер перемагає!`;
      case 'killer_executed':
        return `${name} виявився(-лася) Убивцею і був(ла) страчений(а) за рішенням ради. Невинні перемагають!`;
      case 'killer_majority_wipeout':
        return 'Усіх мирних агентів усунено. Убивця перемагає!';
      case 'killer_majority_outnumbered':
        return 'Команда Убивці тепер дорівнює або переважає кількістю решту мирних агентів. Убивця перемагає!';
      case 'killer_team_disconnected':
        return "Убивця вибув з матчу. Невинні перемагають!";
      case 'CODE_CRACKED':
        return `${name} зламав(ла) код скасування. Невинні перемагають!`;
      default:
        return data.message;
    }
  }
  if (language === 'es') {
    switch (data.reason) {
      case 'joker_executed':
        return `${name} resultó ser el Bromista y fue ejecutado(a) por decisión del consejo. ¡El Bromista gana!`;
      case 'killer_executed':
        return `${name} resultó ser el Asesino y fue ejecutado(a) por decisión del consejo. ¡Los Inocentes ganan!`;
      case 'killer_majority_wipeout':
        return '¡Todos los agentes pacíficos fueron eliminados. El Asesino gana!';
      case 'killer_majority_outnumbered':
        return '¡El equipo del Asesino ahora iguala o supera en número a los agentes pacíficos restantes. El Asesino gana!';
      case 'killer_team_disconnected':
        return '¡El Asesino abandonó la partida. Los Inocentes ganan!';
      case 'CODE_CRACKED':
        return `¡${name} descifró el código de anulación. Los Inocentes ganan!`;
      default:
        return data.message;
    }
  }
  if (language === 'de') {
    switch (data.reason) {
      case 'joker_executed':
        return `${name} entpuppte sich als der Joker und wurde durch Ratsbeschluss hingerichtet. Der Joker gewinnt!`;
      case 'killer_executed':
        return `${name} entpuppte sich als der Mörder und wurde durch Ratsbeschluss hingerichtet. Die Unschuldigen gewinnen!`;
      case 'killer_majority_wipeout':
        return 'Alle friedlichen Agenten wurden ausgeschaltet. Der Mörder gewinnt!';
      case 'killer_majority_outnumbered':
        return 'Das Team des Mörders ist den verbliebenen friedlichen Agenten jetzt zahlenmäßig ebenbürtig oder überlegen. Der Mörder gewinnt!';
      case 'killer_team_disconnected':
        return 'Der Mörder hat das Spiel verlassen. Die Unschuldigen gewinnen!';
      case 'CODE_CRACKED':
        return `${name} hat den Aufhebungscode geknackt. Die Unschuldigen gewinnen!`;
      default:
        return data.message;
    }
  }
  if (language === 'fr') {
    switch (data.reason) {
      case 'joker_executed':
        return `${name} s'est révélé(e) être le Joker et a été exécuté(e) par décision du conseil. Le Joker gagne !`;
      case 'killer_executed':
        return `${name} s'est révélé(e) être le Tueur et a été exécuté(e) par décision du conseil. Les Innocents gagnent !`;
      case 'killer_majority_wipeout':
        return 'Tous les agents pacifiques ont été éliminés. Le Tueur gagne !';
      case 'killer_majority_outnumbered':
        return "L'équipe du Tueur égale ou dépasse désormais en nombre les agents pacifiques restants. Le Tueur gagne !";
      case 'killer_team_disconnected':
        return 'Le Tueur a quitté la partie. Les Innocents gagnent !';
      case 'CODE_CRACKED':
        return `${name} a percé le code d'annulation. Les Innocents gagnent !`;
      default:
        return data.message;
    }
  }
  return data.message;
}

// code_submission_result rejection reasons (trap debuff / undiscovered body /
// wrong code) — surfaced as a toast via pushToast.
function translateCodeSubmissionMessage(payload, language) {
  if (!payload) return '';
  if (language === 'ru') {
    switch (payload.reason) {
      case 'trap_debuff':
        return 'Вы всё ещё приходите в себя после ловушки — терминал не примет ввод в этом раунде.';
      case 'body_missing':
        return 'Выход опечатан — где-то ещё остаётся необнаруженное тело.';
      case 'invalid_code':
        return 'Неверный код';
      default:
        return payload.message || 'Неверный код';
    }
  }
  if (language === 'uk') {
    switch (payload.reason) {
      case 'trap_debuff':
        return 'Ви ще приходите до тями після пастки — термінал не прийме введення в цьому раунді.';
      case 'body_missing':
        return 'Вихід опечатано — десь ще залишається невиявлене тіло.';
      case 'invalid_code':
        return 'Невірний код';
      default:
        return payload.message || 'Невірний код';
    }
  }
  if (language === 'es') {
    switch (payload.reason) {
      case 'trap_debuff':
        return 'Todavía te estás recuperando de una trampa — el terminal no aceptará entradas este turno.';
      case 'body_missing':
        return 'La salida está sellada — aún queda al menos un cuerpo sin descubrir en algún lugar.';
      case 'invalid_code':
        return 'Código incorrecto';
      default:
        return payload.message || 'Código incorrecto';
    }
  }
  if (language === 'de') {
    switch (payload.reason) {
      case 'trap_debuff':
        return 'Du erholst dich noch von einer Falle — das Terminal akzeptiert diese Runde keine Eingaben.';
      case 'body_missing':
        return 'Der Ausgang ist versiegelt — irgendwo ist noch mindestens eine unentdeckte Leiche.';
      case 'invalid_code':
        return 'Falscher Code';
      default:
        return payload.message || 'Falscher Code';
    }
  }
  if (language === 'fr') {
    switch (payload.reason) {
      case 'trap_debuff':
        return "Vous vous remettez encore d'un piège — le terminal n'acceptera aucune saisie ce tour-ci.";
      case 'body_missing':
        return "La sortie est scellée — un corps reste encore introuvable quelque part.";
      case 'invalid_code':
        return 'Code incorrect';
      default:
        return payload.message || 'Code incorrect';
    }
  }
  return payload.message;
}

// --- VENTS: Killer-only shortcut passages, one-way per entry (source ->
// destination). Must mirror the server's VENTS constant exactly — this copy
// is only used to decide when to show the "USE VENT" button and where the
// vent icon renders on the map; the server is the sole authority on whether
// an actual 'use_vent' request is allowed to go through.
const VENTS = {
  f1_hall: 'f2_master',
  f2_master: 'f1_hall',
  f1_kitchen: 'f1_armory',
  f1_armory: 'f1_kitchen',
  f1_cellar: 'f2_attic',
  f2_attic: 'f1_cellar'
};

// --- ROOM INTERIORS: purely cosmetic "what does it look like inside" sketches,
// keyed by the same room id used everywhere else. Each entry gives a short
// flavor description (own words, no external source), an icon, and an accent
// gradient so the reveal panel reads as a distinct little interior rather than
// a generic card. This has no bearing on game logic — the server doesn't know
// or care about any of this, it only tracks WHO is WHERE.
const ROOM_INTERIORS = {
  b_torture: { icon: 'skull', accent: '#e0524a', gradient: 'linear-gradient(160deg, #200909 0%, #0d0404 100%)', text: 'Bare stone walls, a single hanging chain, and a drain in the floor. This is where the council sends whoever it votes out.' },
  f1_hall: { icon: 'candle', accent: '#c9a86a', gradient: 'linear-gradient(160deg, #2a2416 0%, #14120b 100%)', text: 'A vaulted entry hall. Dust drifts through cracked moonlight over a cold marble floor and a dead chandelier.' },
  f1_library: { icon: 'book', accent: '#8a6d3b', gradient: 'linear-gradient(160deg, #241d10 0%, #100d08 100%)', text: 'Floor-to-ceiling shelves lean with age. A ladder still rests against the far wall, as if someone left mid-search.' },
  f1_conservatory: { icon: 'plant', accent: '#4caf7d', gradient: 'linear-gradient(160deg, #10241a 0%, #08120d 100%)', text: 'Overgrown ferns press against fogged glass panes. Rain taps steadily somewhere above the canopy.' },
  f1_kitchen: { icon: 'knife', accent: '#c0524a', gradient: 'linear-gradient(160deg, #2a1412 0%, #140908 100%)', text: 'Copper pans hang untouched. A single knife is missing from the block on the counter.' },
  f1_dining: { icon: 'wine', accent: '#8f2b3a', gradient: 'linear-gradient(160deg, #240f14 0%, #12080a 100%)', text: 'A long table, one chair pushed back sharply. A wine glass lies shattered where it fell.' },
  f1_study: { icon: 'pen', accent: '#5c7a99', gradient: 'linear-gradient(160deg, #101a24 0%, #080d12 100%)', text: 'Papers are scattered across a mahogany desk. A drawer hangs open, emptied in a hurry.' },
  f1_cellar: { icon: 'bottle', accent: '#6a4a8a', gradient: 'linear-gradient(160deg, #1c1424 0%, #0d0812 100%)', text: 'Rows of dusty bottles line stone walls. The air is cold, damp, and unnervingly still.' },
  f1_ballroom: { icon: 'discoball', accent: '#c9a8d8', gradient: 'linear-gradient(160deg, #201a26 0%, #0f0c13 100%)', text: 'An enormous mirrored floor reflects a ceiling of dark, silent chandeliers.' },
  f1_armory: { icon: 'dagger', accent: '#9a9a9a', gradient: 'linear-gradient(160deg, #1c1c1c 0%, #0d0d0d 100%)', text: 'Mounted blades and old firearms line the walls. One mount on the rack sits conspicuously empty.' },
  f1_garage: { icon: 'car', accent: '#556b7a', gradient: 'linear-gradient(160deg, #121a1e 0%, #090d10 100%)', text: 'Oil stains mark the concrete beside an idle car. Tools are hung with military precision.' },
  f1_holding_cell: { icon: 'lock', accent: '#e0524a', gradient: 'linear-gradient(160deg, #241010 0%, #120808 100%)', text: 'A reinforced cell with a single barred window. The lock mechanism hums faintly, active.' },
  f2_master: { icon: 'bed', accent: '#b98fc9', gradient: 'linear-gradient(160deg, #1e1624 0%, #0e0a12 100%)', text: 'Silk sheets lie undisturbed on a grand four-poster bed. A portrait watches from above the fireplace.' },
  f2_bath: { icon: 'bath', accent: '#5fa3c9', gradient: 'linear-gradient(160deg, #101c24 0%, #080e12 100%)', text: 'A claw-foot tub sits half-filled with cold water. Steam still ghosts faintly off the tiles.' },
  f2_guest: { icon: 'luggage', accent: '#9aa8b8', gradient: 'linear-gradient(160deg, #161a1e 0%, #0a0c0e 100%)', text: 'An unpacked suitcase rests on the bed. Whoever stayed here left in a hurry.' },
  f2_nursery: { icon: 'teddybear', accent: '#e0b96a', gradient: 'linear-gradient(160deg, #24200f 0%, #121007 100%)', text: 'A rocking chair sways gently on its own. Faded toys are arranged in careful, untouched rows.' },
  f2_office: { icon: 'briefcase', accent: '#6a8ac9', gradient: 'linear-gradient(160deg, #121a24 0%, #090c12 100%)', text: 'A locked filing cabinet stands beside a cold monitor still glowing faint blue.' },
  f2_gallery: { icon: 'picture', accent: '#c98f6a', gradient: 'linear-gradient(160deg, #241a10 0%, #120d08 100%)', text: 'Rows of oil portraits line the corridor, every painted eye seeming to track your steps.' },
  f2_archive: { icon: 'archive', accent: '#8a8a5c', gradient: 'linear-gradient(160deg, #1e1e12 0%, #0e0e09 100%)', text: 'Endless filing boxes, most unlabeled. One drawer near the back has been forced open.' },
  f2_terrace: { icon: 'moon', accent: '#4a6a8a', gradient: 'linear-gradient(160deg, #0f1620 0%, #080b10 100%)', text: 'Wind howls past a stone balustrade. The storm below swallows the mansion grounds entirely.' },
  f2_attic: { icon: 'web', accent: '#7a7a7a', gradient: 'linear-gradient(160deg, #1a1a1a 0%, #0c0c0c 100%)', text: 'Cobwebbed rafters, old crates, and a single bare bulb swaying overhead.' },
  f2_observatory: { icon: 'telescope', accent: '#4a5a99', gradient: 'linear-gradient(160deg, #10122a 0%, #080814 100%)', text: 'A telescope points at a shattered skylight. Storm clouds have swallowed every star.' }
};

// --- ROOM IMAGES: rooms listed here use a real illustrated photo as their
// scene backdrop instead of the hand-drawn SVG vector room. The image is
// composited inside RoomVisualScene's own <svg> (same coordinate space as
// the vector rooms it replaces), so all the existing ambient effects —
// the light source wash, vignette, glow, dust motes, occupant markers —
// still render on top of it exactly as before. Now covers every room on
// every floor (basement, floor 1, floor 2) — none are left on the vector fallback.
const ROOM_IMAGES = {
  f1_hall: 'https://i.postimg.cc/yYLnqTNn/Gemini-Generated-Image-o6itgso6itgso6it.jpg',
  f1_library: 'https://i.postimg.cc/nhM2nQsT/Gemini-Generated-Image-65n0pz65n0pz65n0.jpg',
  f1_conservatory: 'https://i.postimg.cc/Gm9KbsBQ/Gemini-Generated-Image-6ro4y36ro4y36ro4.jpg',
  f1_kitchen: 'https://i.postimg.cc/gkg49K0N/Gemini-Generated-Image-v3nzlyv3nzlyv3nz.jpg',
  f1_dining: 'https://i.postimg.cc/65MzshQv/Gemini-Generated-Image-xj52oaxj52oaxj52.jpg',
  f1_study: 'https://i.postimg.cc/xT6grPd7/Gemini-Generated-Image-yx4eeryx4eeryx4e.jpg',
  f1_cellar: 'https://i.postimg.cc/xT6grPd4/Gemini-Generated-Image-lp7luxlp7luxlp7l.jpg',
  f1_ballroom: 'https://i.postimg.cc/PrSKGMqp/Gemini-Generated-Image-tqdetctqdetctqde.jpg',
  f1_armory: 'https://i.postimg.cc/X7sxMgvH/Gemini-Generated-Image-ezz2jdezz2jdezz2.jpg',
  f1_garage: 'https://i.postimg.cc/FsTGtxKZ/Gemini-Generated-Image-248h10248h10248h.jpg',
  f1_holding_cell: 'https://i.postimg.cc/XYXLnyZ2/Gemini-Generated-Image-c18034c18034c180.jpg',
  b_torture: 'https://i.postimg.cc/DZ92R3b8/Gemini-Generated-Image-i75id3i75id3i75i.jpg',
  f2_master: 'https://i.postimg.cc/3RsKzQDC/wmremove-transformed.png',
  f2_bath: 'https://i.postimg.cc/0j78sXpC/wmremove-transformed-(1).png',
  f2_guest: 'https://i.postimg.cc/br1zhVQQ/wmremove-transformed-(2).png',
  f2_nursery: 'https://i.postimg.cc/x8L02pKv/wmremove-transformed-(3).png',
  f2_office: 'https://i.postimg.cc/W3B2xcJm/wmremove-transformed-(4).png',
  f2_gallery: 'https://i.postimg.cc/7hSxktgz/wmremove-transformed-(5).png',
  f2_archive: 'https://i.postimg.cc/76FxjrTN/wmremove-transformed-(6).png',
  f2_terrace: 'https://i.postimg.cc/Pxgt0n8N/Gemini-Generated-Image-t5r96ht5r96ht5r9.jpg',
  f2_attic: 'https://i.postimg.cc/B6rqRf1S/Gemini-Generated-Image-7tlwm27tlwm27tlw.jpg',
  f2_observatory: 'https://i.postimg.cc/tTKX8GVW/Gemini-Generated-Image-53sqck53sqck53sq.jpg'
};

// --- ROOM ART: маленькая line-art SVG-иллюстрация интерьера для каждой комнаты.
// Каждая функция принимает цвет акцента комнаты (interior.accent) и возвращает
// набор SVG-примитивов внутри viewBox 0 0 64 64. Полностью заменяет эмодзи-иконку.
const ROOM_ART = {
  b_torture: (c) => (<>
    <rect x="8" y="8" width="48" height="48" fill="none" stroke={c} strokeWidth="1.3"/>
    <line x1="32" y1="8" x2="32" y2="20" stroke={c} strokeWidth="1.2"/>
    <path d="M27 20 L37 20 L34 28 L30 28 Z" fill="none" stroke={c} strokeWidth="1.1"/>
    <line x1="30" y1="28" x2="26" y2="44" stroke={c} strokeWidth="1"/>
    <line x1="34" y1="28" x2="38" y2="44" stroke={c} strokeWidth="1"/>
    <circle cx="32" cy="50" r="4" fill="none" stroke={c} strokeWidth="1.2"/>
    <line x1="10" y1="54" x2="20" y2="54" stroke={c} strokeWidth="0.8" strokeDasharray="2 2"/>
    <line x1="44" y1="54" x2="54" y2="54" stroke={c} strokeWidth="0.8" strokeDasharray="2 2"/>
  </>),
  f1_hall: (c) => (<>
    <circle cx="32" cy="18" r="6" fill="none" stroke={c} strokeWidth="1.5"/>
    <line x1="32" y1="4" x2="32" y2="14" stroke={c} strokeWidth="1.5"/>
    <line x1="26" y1="22" x2="20" y2="30" stroke={c} strokeWidth="1"/>
    <line x1="38" y1="22" x2="44" y2="30" stroke={c} strokeWidth="1"/>
    <line x1="32" y1="24" x2="32" y2="32" stroke={c} strokeWidth="1"/>
    <rect x="8" y="34" width="6" height="26" fill="none" stroke={c} strokeWidth="1.2"/>
    <rect x="50" y="34" width="6" height="26" fill="none" stroke={c} strokeWidth="1.2"/>
    <line x1="4" y1="60" x2="60" y2="60" stroke={c} strokeWidth="1.5"/>
  </>),
  f1_library: (c) => (<>
    <rect x="10" y="10" width="44" height="44" fill="none" stroke={c} strokeWidth="1.2"/>
    <line x1="10" y1="24" x2="54" y2="24" stroke={c} strokeWidth="1"/>
    <line x1="10" y1="38" x2="54" y2="38" stroke={c} strokeWidth="1"/>
    <rect x="13" y="12" width="4" height="10" fill={c} fillOpacity="0.5"/>
    <rect x="19" y="14" width="4" height="8" fill={c} fillOpacity="0.5"/>
    <rect x="25" y="11" width="4" height="11" fill={c} fillOpacity="0.5"/>
    <rect x="14" y="26" width="4" height="10" fill={c} fillOpacity="0.5"/>
    <rect x="21" y="27" width="4" height="9" fill={c} fillOpacity="0.5"/>
    <line x1="46" y1="42" x2="52" y2="12" stroke={c} strokeWidth="1"/>
    <line x1="42" y1="42" x2="48" y2="12" stroke={c} strokeWidth="1"/>
  </>),
  f1_conservatory: (c) => (<>
    <path d="M32 56 C32 40 20 34 14 20" fill="none" stroke={c} strokeWidth="1.4"/>
    <path d="M32 56 C32 40 44 34 50 20" fill="none" stroke={c} strokeWidth="1.4"/>
    <path d="M32 56 V16" fill="none" stroke={c} strokeWidth="1.4"/>
    <path d="M32 30 C28 26 22 26 18 22" fill="none" stroke={c} strokeWidth="1"/>
    <path d="M32 30 C36 26 42 26 46 22" fill="none" stroke={c} strokeWidth="1"/>
    <path d="M32 42 C27 39 21 39 16 36" fill="none" stroke={c} strokeWidth="1"/>
    <path d="M32 42 C37 39 43 39 48 36" fill="none" stroke={c} strokeWidth="1"/>
  </>),
  f1_kitchen: (c) => (<>
    <rect x="16" y="30" width="32" height="26" fill="none" stroke={c} strokeWidth="1.3"/>
    <line x1="22" y1="30" x2="22" y2="14" stroke={c} strokeWidth="1"/>
    <line x1="29" y1="30" x2="29" y2="10" stroke={c} strokeWidth="1"/>
    <line x1="36" y1="30" x2="36" y2="16" stroke={c} strokeWidth="1"/>
    <line x1="43" y1="30" x2="43" y2="28" stroke={c} strokeWidth="1" strokeDasharray="2 2"/>
    <circle cx="43" cy="24" r="1.5" fill={c}/>
  </>),
  f1_dining: (c) => (<>
    <line x1="8" y1="48" x2="56" y2="48" stroke={c} strokeWidth="1.4"/>
    <line x1="14" y1="48" x2="14" y2="58" stroke={c} strokeWidth="1.2"/>
    <line x1="50" y1="48" x2="50" y2="58" stroke={c} strokeWidth="1.2"/>
    <path d="M30 30 L34 44 L26 44 Z" fill="none" stroke={c} strokeWidth="1.2"/>
    <line x1="30" y1="30" x2="30" y2="22" stroke={c} strokeWidth="1.2"/>
    <line x1="38" y1="46" x2="43" y2="42" stroke={c} strokeWidth="1"/>
    <line x1="41" y1="48" x2="46" y2="45" stroke={c} strokeWidth="1"/>
  </>),
  f1_study: (c) => (<>
    <rect x="10" y="34" width="44" height="6" fill="none" stroke={c} strokeWidth="1.2"/>
    <rect x="14" y="40" width="10" height="14" fill="none" stroke={c} strokeWidth="1"/>
    <rect x="15" y="43" width="8" height="3" fill={c} fillOpacity="0.4"/>
    <line x1="28" y1="30" x2="46" y2="26" stroke={c} strokeWidth="1"/>
    <line x1="30" y1="33" x2="48" y2="29" stroke={c} strokeWidth="1"/>
    <line x1="32" y1="36" x2="44" y2="33" stroke={c} strokeWidth="1"/>
  </>),
  f1_cellar: (c) => (<>
    <rect x="10" y="12" width="44" height="40" fill="none" stroke={c} strokeWidth="1.2"/>
    <line x1="10" y1="26" x2="54" y2="26" stroke={c} strokeWidth="0.8"/>
    <line x1="10" y1="39" x2="54" y2="39" stroke={c} strokeWidth="0.8"/>
    <circle cx="18" cy="19" r="3" fill={c} fillOpacity="0.5"/>
    <circle cx="28" cy="19" r="3" fill={c} fillOpacity="0.5"/>
    <circle cx="38" cy="19" r="3" fill={c} fillOpacity="0.5"/>
    <circle cx="22" cy="32.5" r="3" fill={c} fillOpacity="0.5"/>
    <circle cx="34" cy="32.5" r="3" fill={c} fillOpacity="0.5"/>
    <circle cx="46" cy="32.5" r="3" fill={c} fillOpacity="0.5"/>
  </>),
  f1_ballroom: (c) => (<>
    <circle cx="32" cy="14" r="5" fill="none" stroke={c} strokeWidth="1.2"/>
    <line x1="32" y1="19" x2="32" y2="26" stroke={c} strokeWidth="1"/>
    <path d="M8 56 L32 34 L56 56 Z" fill="none" stroke={c} strokeWidth="1"/>
    <line x1="16" y1="56" x2="32" y2="42" stroke={c} strokeWidth="0.7"/>
    <line x1="48" y1="56" x2="32" y2="42" stroke={c} strokeWidth="0.7"/>
  </>),
  f1_armory: (c) => (<>
    <line x1="16" y1="10" x2="40" y2="46" stroke={c} strokeWidth="1.4"/>
    <line x1="40" y1="10" x2="16" y2="46" stroke={c} strokeWidth="1.4"/>
    <circle cx="28" cy="28" r="2" fill={c}/>
    <rect x="46" y="38" width="12" height="3" fill="none" stroke={c} strokeWidth="1" strokeDasharray="2 2"/>
  </>),
  f1_garage: (c) => (<>
    <path d="M10 42 L14 30 Q18 26 26 26 L38 26 Q46 26 50 30 L54 42 Z" fill="none" stroke={c} strokeWidth="1.3"/>
    <circle cx="20" cy="44" r="4" fill="none" stroke={c} strokeWidth="1.2"/>
    <circle cx="44" cy="44" r="4" fill="none" stroke={c} strokeWidth="1.2"/>
    <line x1="10" y1="18" x2="18" y2="10" stroke={c} strokeWidth="1.4"/>
    <line x1="18" y1="10" x2="14" y2="14" stroke={c} strokeWidth="1.4"/>
  </>),
  f1_holding_cell: (c) => (<>
    <rect x="10" y="10" width="44" height="44" fill="none" stroke={c} strokeWidth="1.3"/>
    <line x1="19" y1="10" x2="19" y2="54" stroke={c} strokeWidth="1.2"/>
    <line x1="28" y1="10" x2="28" y2="54" stroke={c} strokeWidth="1.2"/>
    <line x1="37" y1="10" x2="37" y2="54" stroke={c} strokeWidth="1.2"/>
    <line x1="46" y1="10" x2="46" y2="54" stroke={c} strokeWidth="1.2"/>
    <circle cx="32" cy="32" r="2" fill={c} fillOpacity="0.6"/>
  </>),
  f2_master: (c) => (<>
    <rect x="14" y="34" width="36" height="16" fill="none" stroke={c} strokeWidth="1.2"/>
    <line x1="14" y1="34" x2="14" y2="14" stroke={c} strokeWidth="1"/>
    <line x1="50" y1="34" x2="50" y2="14" stroke={c} strokeWidth="1"/>
    <line x1="14" y1="14" x2="50" y2="14" stroke={c} strokeWidth="1"/>
    <path d="M14 14 Q32 22 50 14" fill="none" stroke={c} strokeWidth="0.8"/>
    <rect x="17" y="30" width="10" height="6" fill={c} fillOpacity="0.4"/>
  </>),
  f2_bath: (c) => (<>
    <path d="M12 40 Q12 50 24 50 L44 50 Q52 50 52 40" fill="none" stroke={c} strokeWidth="1.3"/>
    <line x1="12" y1="40" x2="52" y2="40" stroke={c} strokeWidth="1.3"/>
    <line x1="16" y1="50" x2="14" y2="55" stroke={c} strokeWidth="1.2"/>
    <line x1="48" y1="50" x2="50" y2="55" stroke={c} strokeWidth="1.2"/>
    <path d="M42 40 Q42 30 34 30" fill="none" stroke={c} strokeWidth="1.2"/>
    <line x1="34" y1="30" x2="34" y2="26" stroke={c} strokeWidth="1.2"/>
  </>),
  f2_guest: (c) => (<>
    <rect x="14" y="24" width="36" height="26" rx="2" fill="none" stroke={c} strokeWidth="1.3"/>
    <line x1="14" y1="34" x2="50" y2="34" stroke={c} strokeWidth="1"/>
    <rect x="27" y="18" width="10" height="6" fill="none" stroke={c} strokeWidth="1.2"/>
    <line x1="22" y1="24" x2="22" y2="50" stroke={c} strokeWidth="0.6"/>
    <line x1="42" y1="24" x2="42" y2="50" stroke={c} strokeWidth="0.6"/>
  </>),
  f2_nursery: (c) => (<>
    <path d="M14 50 Q32 58 50 50" fill="none" stroke={c} strokeWidth="1.4"/>
    <line x1="20" y1="50" x2="24" y2="30" stroke={c} strokeWidth="1.2"/>
    <line x1="44" y1="50" x2="40" y2="30" stroke={c} strokeWidth="1.2"/>
    <path d="M22 30 Q32 20 42 30" fill="none" stroke={c} strokeWidth="1.2"/>
    <circle cx="26" cy="27" r="1.4" fill={c}/>
  </>),
  f2_office: (c) => (<>
    <rect x="12" y="20" width="16" height="34" fill="none" stroke={c} strokeWidth="1.2"/>
    <line x1="12" y1="31" x2="28" y2="31" stroke={c} strokeWidth="0.8"/>
    <line x1="12" y1="42" x2="28" y2="42" stroke={c} strokeWidth="0.8"/>
    <rect x="36" y="24" width="18" height="13" fill="none" stroke={c} strokeWidth="1.2"/>
    <rect x="42" y="37" width="6" height="4" fill="none" stroke={c} strokeWidth="1"/>
    <circle cx="45" cy="30.5" r="2" fill={c} fillOpacity="0.7"/>
  </>),
  f2_gallery: (c) => (<>
    <rect x="8" y="16" width="12" height="16" fill="none" stroke={c} strokeWidth="1.1"/>
    <rect x="26" y="14" width="12" height="18" fill="none" stroke={c} strokeWidth="1.1"/>
    <rect x="44" y="16" width="12" height="16" fill="none" stroke={c} strokeWidth="1.1"/>
    <circle cx="14" cy="22" r="2" fill={c} fillOpacity="0.5"/>
    <circle cx="32" cy="21" r="2" fill={c} fillOpacity="0.5"/>
    <circle cx="50" cy="22" r="2" fill={c} fillOpacity="0.5"/>
    <line x1="6" y1="46" x2="58" y2="46" stroke={c} strokeWidth="1"/>
  </>),
  f2_archive: (c) => (<>
    <rect x="10" y="34" width="16" height="14" fill="none" stroke={c} strokeWidth="1.2"/>
    <rect x="28" y="26" width="16" height="14" fill="none" stroke={c} strokeWidth="1.2"/>
    <rect x="28" y="42" width="16" height="10" fill="none" stroke={c} strokeWidth="1.1" strokeDasharray="2 2"/>
    <rect x="46" y="30" width="14" height="18" fill="none" stroke={c} strokeWidth="1.2"/>
  </>),
  f2_terrace: (c) => (<>
    <circle cx="46" cy="16" r="7" fill="none" stroke={c} strokeWidth="1.3"/>
    <line x1="8" y1="50" x2="56" y2="50" stroke={c} strokeWidth="1.3"/>
    <line x1="12" y1="50" x2="12" y2="38" stroke={c} strokeWidth="1"/>
    <line x1="20" y1="50" x2="20" y2="38" stroke={c} strokeWidth="1"/>
    <line x1="28" y1="50" x2="28" y2="38" stroke={c} strokeWidth="1"/>
    <line x1="8" y1="38" x2="36" y2="38" stroke={c} strokeWidth="1"/>
  </>),
  f2_attic: (c) => (<>
    <rect x="14" y="36" width="18" height="16" fill="none" stroke={c} strokeWidth="1.2"/>
    <line x1="14" y1="44" x2="32" y2="44" stroke={c} strokeWidth="0.8"/>
    <path d="M44 10 Q52 12 50 20 Q48 12 40 14 Q46 16 44 22" fill="none" stroke={c} strokeWidth="0.8"/>
    <line x1="40" y1="30" x2="40" y2="52" stroke={c} strokeWidth="0.6"/>
    <circle cx="40" cy="26" r="2.5" fill="none" stroke={c} strokeWidth="1"/>
  </>),
  f2_observatory: (c) => (<>
    <line x1="20" y1="52" x2="34" y2="26" stroke={c} strokeWidth="1.6"/>
    <line x1="24" y1="52" x2="38" y2="26" stroke={c} strokeWidth="1.6"/>
    <line x1="30" y1="30" x2="46" y2="18" stroke={c} strokeWidth="1.3"/>
    <circle cx="46" cy="18" r="2.5" fill="none" stroke={c} strokeWidth="1.2"/>
    <line x1="10" y1="10" x2="56" y2="10" stroke={c} strokeWidth="0.8"/>
    <line x1="18" y1="6" x2="26" y2="14" stroke={c} strokeWidth="0.7"/>
  </>)
};

// --- VECTOR ICON SET ---------------------------------------------------------
// Every glyph the UI used to render as an emoji (skull, knife, lock, search,
// back-arrow, etc.) is drawn
// here instead as a small stroke-based line icon, in the same neon/thin-line
// visual language as the rest of the interface (see NeonButton, RoomVisualScene's
// X-mark, etc). Using `currentColor` by default means an <Icon> inherits
// whatever color its surrounding text/span already has, so callers rarely need
// to pass one explicitly.
const ICON_PATHS = {
  flask: (
    <>
      <path d="M9 3h6" />
      <path d="M10 3v6.2L4.8 18a2 2 0 0 0 1.7 3h11a2 2 0 0 0 1.7-3L14 9.2V3" />
      <path d="M7.5 15h9" />
    </>
  ),
  skull: (
    <>
      <path d="M12 3C7.6 3 4 6.4 4 10.5c0 2.3 1.1 4.3 2.8 5.6V19a1 1 0 0 0 1 1h1.4v-2h1.2v2h2.2v-2h1.2v2H15a1 1 0 0 0 1-1v-2.9c1.7-1.3 2.8-3.3 2.8-5.6C18.8 6.4 15.2 3 12 3z" />
      <circle cx="9.3" cy="10.2" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="14.7" cy="10.2" r="1.4" fill="currentColor" stroke="none" />
      <path d="M11 13.3h2l-1 1.6z" fill="currentColor" stroke="none" />
    </>
  ),
  knife: (
    <>
      <path d="M4 20 15 9" />
      <path d="M13 7 20 4l-3 7-4-1z" />
      <path d="M13 7l1.6 1.6" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  unlock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 7.4-2" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M19 19l-4.3-4.3" />
    </>
  ),
  vent: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 12C12 8 9 6 6 6.5c1 3 3 4.5 6 5.5z" fill="currentColor" stroke="none" />
      <path d="M12 12c4 0 6-3 5.5-6-3 1-4.5 3-5.5 6z" fill="currentColor" stroke="none" />
      <path d="M12 12c0 4 3 6 6 5.5-1-3-3-4.5-6-5.5z" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  hatch: (
    <>
      <path d="M4 9c0-2.2 3.6-4 8-4s8 1.8 8 4" />
      <ellipse cx="12" cy="9" rx="8" ry="4" />
      <path d="M4 9v3c0 2.2 3.6 4 8 4s8-1.8 8-4V9" />
      <path d="M9 12l6-3M9 9l6 3" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3 2 20h20L12 3z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  arrowLeft: (
    <>
      <path d="M19 12H5" />
      <path d="M11 6l-6 6 6 6" />
    </>
  ),
  users: (
    <>
      <circle cx="8.5" cy="8" r="3" />
      <path d="M2.5 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <circle cx="17" cy="9" r="2.4" />
      <path d="M15.5 14.2c2.6.4 4.5 2.6 4.5 5.3" />
    </>
  ),
  mapPin: (
    <>
      <path d="M12 21s7-6.3 7-11.5a7 7 0 1 0-14 0C5 14.7 12 21 12 21z" />
      <circle cx="12" cy="9.5" r="2.4" />
    </>
  ),
  hourglass: (
    <>
      <path d="M6 3h12M6 21h12" />
      <path d="M7 3c0 4.5 3 6 5 7.5C10 12 7 13.5 7 18v3M17 3c0 4.5-3 6-5 7.5 2 1.5 5 3 5 7.5v3" />
    </>
  ),
  crown: (
    <>
      <path d="M3 8l4 3 5-6 5 6 4-3-2 10H5L3 8z" />
      <path d="M5 18h14" />
    </>
  ),
  check: (
    <path d="M4 12l5 5L20 6" />
  ),
  candle: (
    <>
      <path d="M12 3c1.2 1.5 1.8 2.6 1.8 3.6a1.8 1.8 0 1 1-3.6 0C10.2 5.6 10.8 4.5 12 3z" />
      <rect x="9" y="8.5" width="6" height="11" rx="1" />
      <path d="M9 12.5h6" />
    </>
  ),
  book: (
    <>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H12v17H6.5A2.5 2.5 0 0 0 4 22.5z" />
      <path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H12v17h5.5a2.5 2.5 0 0 1 2.5 2.5z" />
    </>
  ),
  plant: (
    <>
      <path d="M12 21v-9" />
      <path d="M12 12c0-4 3-6 7-6 0 4-3 6-7 6z" />
      <path d="M12 15c0-3.5-2.5-5.2-6-5.2 0 3.5 2.5 5.2 6 5.2z" />
    </>
  ),
  wine: (
    <>
      <path d="M7 3h10l-1 6a4 4 0 0 1-8 0z" />
      <path d="M12 13v6M8 21h8" />
    </>
  ),
  pen: (
    <>
      <path d="M4 20l1-4 11-11 3 3-11 11z" />
      <path d="M14 6l3 3" />
    </>
  ),
  bottle: (
    <>
      <path d="M10 2h4v3.5l1.5 2.5v13H8.5v-13L10 5.5z" />
      <path d="M9.5 11h5" />
    </>
  ),
  discoball: (
    <>
      <circle cx="12" cy="12" r="7" />
      <path d="M5 12h14M12 5v14" />
      <path d="M7 7l10 10M17 7L7 17" />
    </>
  ),
  dagger: (
    <>
      <path d="M12 2v13" />
      <path d="M8 6h8" />
      <path d="M10 15h4l-2 7z" />
    </>
  ),
  car: (
    <>
      <path d="M4 16l1.5-5.5A2 2 0 0 1 7.4 9h9.2a2 2 0 0 1 1.9 1.5L20 16" />
      <rect x="3" y="16" width="18" height="4" rx="1.5" />
      <circle cx="7.5" cy="20" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="20" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  bed: (
    <>
      <path d="M3 19v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6" />
      <path d="M3 19v2M21 19v2" />
      <path d="M5 11V7h6v4" />
    </>
  ),
  bath: (
    <>
      <path d="M4 12h16v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" />
      <path d="M3 19l1 2M20 19l-1 2" />
      <path d="M6 12V7a2 2 0 0 1 3.5-1.3" />
    </>
  ),
  luggage: (
    <>
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M9 8V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v3" />
      <path d="M9 12v4M15 12v4" />
    </>
  ),
  teddybear: (
    <>
      <circle cx="12" cy="13" r="6" />
      <circle cx="7" cy="6.5" r="2" />
      <circle cx="17" cy="6.5" r="2" />
      <circle cx="9.6" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.4" cy="12" r="1" fill="currentColor" stroke="none" />
      <path d="M10.5 15.5a2 1.4 0 0 0 3 0" />
    </>
  ),
  briefcase: (
    <>
      <rect x="3" y="7.5" width="18" height="12" rx="2" />
      <path d="M8.5 7.5V6a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v1.5" />
      <path d="M3 13h18" />
    </>
  ),
  picture: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="1.5" />
      <circle cx="9" cy="9.5" r="1.6" />
      <path d="M5 17l5-5 3 3 2.5-2.5L20 17" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="4" width="18" height="4.5" rx="1" />
      <path d="M4.5 8.5v9a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-9" />
      <path d="M10 12.5h4" />
    </>
  ),
  moon: (
    <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z" />
  ),
  web: (
    <>
      <path d="M12 2v20M2 12h20" />
      <path d="M4.9 4.9l14.2 14.2M19.1 4.9L4.9 19.1" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="8.5" />
    </>
  ),
  telescope: (
    <>
      <path d="M3 16l12-6.5 2.5 4.7L5.5 21z" />
      <path d="M13.5 10.5 19 7l1.5 2.7-5.3 3.3" />
      <path d="M8 19l-2.5 2M11 21l-2-1" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3.5 6.5l8.5 7 8.5-7" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </>
  )
};

function Icon({ name, size = 14, color = 'currentColor', style, title }) {
  const paths = ICON_PATHS[name];
  if (!paths) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke={color}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style }}
      role={title ? 'img' : undefined}
      aria-label={title}
    >
      {title && <title>{title}</title>}
      {paths}
    </svg>
  );
}

// Рендерит SVG-иллюстрацию комнаты по её id, либо ничего, если для id нет арта.
function RoomArtIcon({ roomId, color }) {
  const art = ROOM_ART[roomId];
  if (!art) return null;
  return (
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" style={{ display: 'block', maxWidth: '100%', maxHeight: '100%' }}>
      {art(color)}
    </svg>
  );
}

function RoomVisualScene({ roomId, accent, occupants = [], bodies = [] }) {
  const base = ROOM_INTERIORS[roomId];
  const color = accent || base?.accent || '#00ff87';
  const sceneWidth = 320;
  const sceneHeight = 220;
  // Rooms with a real photo backdrop skip the hand-drawn vector scene
  // entirely — see ROOM_IMAGES above.
  const roomImage = ROOM_IMAGES[roomId];

  // Ambient dust motes: a small, fixed set of floating particles drifting
  // slowly across the scene. Positions/timings are derived deterministically
  // from roomId + index (not Math.random on every render) so the field
  // doesn't visibly "jump" on re-render and stays identical across clients.
  const dustMotes = useMemo(() => {
    let seed = 0;
    for (let i = 0; i < roomId.length; i++) seed = (seed * 31 + roomId.charCodeAt(i)) >>> 0;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return (seed % 10000) / 10000;
    };
    return Array.from({ length: 9 }).map((_, i) => ({
      id: i,
      left: 12 + rand() * 76,
      top: 15 + rand() * 65,
      size: 1.5 + rand() * 2.5,
      duration: 7 + rand() * 8,
      delay: -rand() * 10,
      driftX: (rand() - 0.5) * 40,
      driftY: -20 - rand() * 30,
      opacity: 0.25 + rand() * 0.4
    }));
  }, [roomId]);

  // Living occupants AND any bodies left behind in this room share one combined
  // layout pass — a body is a former occupant who no longer moves on their own,
  // but their big avatar icon should stay put in the scene rather than just
  // vanishing, so it's positioned by the same grid math instead of being
  // dropped into a separate list.
  const entities = [
    ...occupants.map(o => ({ ...o, isBody: false })),
    ...bodies.map(b => ({ ...b, isBody: true }))
  ];

  // --- ENTITY POSITIONS: assigned SERVER-SIDE (see getEntityPosition in
  // server.js), keyed by the room + the entity's id — a living occupant's
  // own id, or a body's playerId, falling back to nickname for either — and
  // sent down as x/y on each occupant/body. This used to be generated
  // independently on every client via Math.random(), which meant the exact
  // same room looked different from player to player (whoever was "in the
  // center" for one person could be in a corner for someone else). Now every
  // client just renders the coordinates the server already picked, so
  // everyone sees the same layout. A killed occupant's body carries over the
  // exact same id (and the same x/y) their living self already had, so the
  // marker doesn't jump the instant they die — it just switches from
  // "occupant" look to "body" look in place.
  const getEntityId = (entity) =>
    entity.isBody ? (entity.playerId || entity.nickname) : (entity.id || entity.nickname);

  const FALLBACK_POSITION = { x: 50, y: 67 };

  const getOccupantPosition = (entity) => {
    if (typeof entity.x === 'number' && typeof entity.y === 'number') {
      return { x: entity.x, y: entity.y };
    }
    // Only hit for data that predates the server sending coordinates (e.g.
    // a stale cached payload) — falls back to a shared, fixed spot rather
    // than a per-client random one so it still stays in sync everywhere.
    return FALLBACK_POSITION;
  };

  // Tracks which entity ids this scene has already rendered once, purely to
  // drive the "just walked in" entrance animation below — kept separate from
  // position assignment now that positions come from the server rather than
  // being generated (and thus first-seen) locally. Resets whenever roomId
  // changes, same as before.
  const seenIdsRef = useRef({ roomId: null, ids: new Set() });
  if (seenIdsRef.current.roomId !== roomId) {
    seenIdsRef.current = { roomId, ids: new Set() };
  }
  const newlyPlacedIds = new Set();
  entities.forEach(entity => {
    const id = getEntityId(entity);
    if (id && !seenIdsRef.current.ids.has(id)) {
      seenIdsRef.current.ids.add(id);
      newlyPlacedIds.add(id);
    }
  });

  const renderScene = () => {
    switch (roomId) {
      case 'f1_hall':
        return (
          <>
            <rect x="18" y="18" width="284" height="184" rx="24" fill="rgba(24,17,10,0.72)" />
            <rect x="34" y="34" width="252" height="152" rx="18" fill="rgba(255,255,255,0.04)" stroke={color} strokeWidth="1.2" strokeOpacity="0.75" />
            {/* Runner rug with a bordered pattern down the center of the hall */}
            <rect x="56" y="56" width="208" height="112" rx="18" fill="url(#floorHall)" stroke="rgba(255,255,255,0.16)" strokeWidth="1" />
            <rect x="66" y="66" width="188" height="92" rx="10" fill="none" stroke={color} strokeWidth="0.8" strokeOpacity="0.4" strokeDasharray="4 4" />
            {/* Grand archway threshold */}
            <path d="M76 132 C104 100 130 92 160 92 C190 92 214 100 242 132" fill="none" stroke={color} strokeWidth="2" strokeOpacity="0.9" />
            {/* Chandelier: chain + fixture + candle glow dots */}
            <line x1="160" y1="40" x2="160" y2="68" stroke="rgba(255,255,255,0.3)" strokeWidth="1.2" />
            <circle cx="160" cy="92" r="24" fill="rgba(255,255,255,0.06)" stroke={color} strokeWidth="1.3" />
            <circle cx="148" cy="88" r="2.4" fill={color} fillOpacity="0.85" />
            <circle cx="172" cy="88" r="2.4" fill={color} fillOpacity="0.85" />
            <circle cx="160" cy="80" r="2.4" fill={color} fillOpacity="0.85" />
            {/* Console tables flanking the entry, each with a vase */}
            <rect x="74" y="48" width="52" height="18" rx="8" fill="rgba(255,255,255,0.12)" />
            <ellipse cx="100" cy="46" rx="6" ry="9" fill="rgba(255,255,255,0.14)" stroke={color} strokeWidth="1" />
            <rect x="194" y="48" width="52" height="18" rx="8" fill="rgba(255,255,255,0.12)" />
            <ellipse cx="220" cy="46" rx="6" ry="9" fill="rgba(255,255,255,0.14)" stroke={color} strokeWidth="1" />
            {/* Bench beneath the arch */}
            <rect x="100" y="138" width="120" height="24" rx="12" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.2)" />
            <path d="M108 138 V162 M212 138 V162" stroke="rgba(255,255,255,0.14)" strokeWidth="1.4" />
            {/* Coat rack in the corner */}
            <line x1="252" y1="150" x2="252" y2="102" stroke="rgba(255,255,255,0.3)" strokeWidth="2" />
            <circle cx="252" cy="102" r="10" fill="none" stroke="rgba(255,255,255,0.24)" strokeWidth="1.4" />
            <path d="M246 108 L248 118 M258 108 L256 118" stroke="rgba(255,255,255,0.22)" strokeWidth="1.2" />
            <path d="M94 176 H226" stroke="rgba(255,255,255,0.14)" strokeWidth="2" />
          </>
        );
      case 'f1_library':
        return (
          <>
            <rect x="18" y="18" width="284" height="184" rx="24" fill="rgba(21,16,9,0.75)" />
            <rect x="36" y="38" width="248" height="144" rx="18" fill="rgba(255,255,255,0.04)" stroke={color} strokeWidth="1.2" strokeOpacity="0.75" />
            <rect x="56" y="54" width="208" height="106" rx="16" fill="url(#floorLibrary)" stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
            {/* Three tall bookshelves, each with colorful book spines and a top shelf */}
            <rect x="74" y="66" width="48" height="82" rx="8" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.24)" />
            <rect x="136" y="66" width="48" height="82" rx="8" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.24)" />
            <rect x="198" y="66" width="48" height="82" rx="8" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.24)" />
            {[74, 136, 198].map((sx) => (
              <g key={sx}>
                <path d={`M${sx + 4} 84 H${sx + 44} M${sx + 4} 106 H${sx + 44} M${sx + 4} 128 H${sx + 44}`} stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <rect key={i} x={sx + 6 + i * 6.5} y={72} width="4.6" height="12" fill={color} fillOpacity={0.22 + (i % 3) * 0.12} />
                ))}
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <rect key={`b-${i}`} x={sx + 6 + i * 6.5} y={94} width="4.6" height="12" fill="rgba(255,255,255,0.14)" fillOpacity={0.5 + (i % 2) * 0.2} />
                ))}
              </g>
            ))}
            <rect x="88" y="60" width="20" height="16" rx="4" fill="rgba(255,255,255,0.16)" />
            <rect x="150" y="60" width="20" height="16" rx="4" fill="rgba(255,255,255,0.16)" />
            <rect x="212" y="60" width="20" height="16" rx="4" fill="rgba(255,255,255,0.16)" />
            {/* Reading table with an open book */}
            <rect x="92" y="148" width="136" height="14" rx="7" fill="rgba(255,255,255,0.06)" />
            <path d="M144 149 L160 145 L176 149 L176 155 L160 151 L144 155 Z" fill="rgba(255,255,255,0.16)" stroke={color} strokeWidth="0.8" />
            {/* Reading armchair */}
            <rect x="64" y="138" width="32" height="30" rx="8" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.16)" />
            <path d="M64 148 H96" stroke="rgba(255,255,255,0.14)" />
            {/* Standing globe on a stand */}
            <circle cx="248" cy="150" r="10" fill="rgba(255,255,255,0.08)" stroke={color} strokeWidth="1.2" />
            <path d="M240 150 H256 M248 142 V158" stroke={color} strokeWidth="0.7" strokeOpacity="0.6" />
            <path d="M248 160 L244 168 M248 160 L252 168" stroke="rgba(255,255,255,0.24)" strokeWidth="1.4" />
            {/* Sliding ladder against the far shelf */}
            <line x1="230" y1="66" x2="220" y2="148" stroke="rgba(255,255,255,0.3)" strokeWidth="1.6" />
            <line x1="238" y1="66" x2="228" y2="148" stroke="rgba(255,255,255,0.3)" strokeWidth="1.6" />
            <path d="M223 96 L235 94 M221 116 L233 114 M219 136 L231 134" stroke="rgba(255,255,255,0.24)" strokeWidth="1.4" />
          </>
        );
      case 'f1_conservatory':
        return (<>
          <rect x="18" y="18" width="284" height="184" rx="24" fill="rgba(10,28,20,0.78)" />
          <rect x="34" y="36" width="252" height="148" rx="20" fill="rgba(255,255,255,0.04)" stroke={color} strokeWidth="1.2" strokeOpacity="0.75" />
          {/* Glass-paned dome window */}
          <path d="M58 164 V58 H262 V164 M58 92 H262 M110 58 V164 M160 58 V164 M210 58 V164" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.2" />
          {/* Central palm with layered fronds */}
          <path d="M160 162 C156 126 126 112 94 86 M160 162 C166 126 196 112 228 86 M160 162 V78 M160 120 C150 108 132 104 116 94 M160 120 C170 108 188 104 204 94" fill="none" stroke={color} strokeWidth="2" />
          {/* Wicker armchair */}
          <rect x="70" y="140" width="30" height="26" rx="10" fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.24)" />
          <path d="M74 140 V166 M80 140 V166 M86 140 V166 M92 140 V166" stroke="rgba(255,255,255,0.16)" strokeWidth="0.8" />
          {/* Round side table */}
          <ellipse cx="128" cy="158" rx="16" ry="6" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.22)" />
          <line x1="128" y1="158" x2="128" y2="170" stroke="rgba(255,255,255,0.2)" strokeWidth="2" />
          {/* Potted ferns of varying size */}
          <ellipse cx="96" cy="108" rx="18" ry="9" fill="rgba(76,175,125,0.22)" stroke={color} strokeWidth="1" />
          <path d="M96 108 Q84 96 76 106 M96 108 Q108 92 116 100 M96 108 Q96 88 100 98" fill="none" stroke={color} strokeWidth="1" strokeOpacity="0.7" />
          <ellipse cx="224" cy="108" rx="18" ry="9" fill="rgba(76,175,125,0.22)" stroke={color} strokeWidth="1" />
          <path d="M224 108 Q212 94 204 104 M224 108 Q236 90 244 98 M224 108 Q224 86 228 96" fill="none" stroke={color} strokeWidth="1" strokeOpacity="0.7" />
          <ellipse cx="238" cy="150" rx="10" ry="6" fill="rgba(76,175,125,0.18)" stroke={color} strokeWidth="0.9" />
          <path d="M238 150 Q230 140 224 146 M238 150 Q246 138 252 144" fill="none" stroke={color} strokeWidth="0.9" strokeOpacity="0.6" />
        </>);
      case 'f1_dining':
        return (<>
          <rect x="18" y="18" width="284" height="184" rx="24" fill="rgba(32,12,18,0.8)" />
          <rect x="36" y="38" width="248" height="144" rx="18" fill="rgba(255,255,255,0.04)" stroke={color} strokeWidth="1.2" strokeOpacity="0.75" />
          {/* Long dining table */}
          <rect x="72" y="76" width="176" height="78" rx="20" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.24)" />
          {/* Chair backs around the table */}
          <path d="M94 70 V58 M126 70 V58 M160 70 V58 M194 70 V58 M226 70 V58 M94 160 V172 M126 160 V172 M194 160 V172 M226 160 V172" stroke={color} strokeWidth="2" />
          {/* Place settings: plates + tiny forks */}
          {[94, 126, 194, 226].map((x) => (
            <g key={x}>
              <circle cx={x} cy={x < 160 ? 92 : 92} r="7" fill="rgba(255,255,255,0.1)" stroke="rgba(255,255,255,0.28)" strokeWidth="0.8" />
              <line x1={x - 12} y1="88" x2={x - 12} y2="98" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
            </g>
          ))}
          {/* Candelabra centerpiece */}
          <path d="M150 92 L160 124 L170 92 Z" fill="rgba(255,255,255,0.08)" stroke={color} strokeWidth="1.2" />
          <path d="M160 124 V140" stroke={color} strokeWidth="1.4" />
          <circle cx="150" cy="90" r="2" fill={color} fillOpacity="0.8" />
          <circle cx="170" cy="90" r="2" fill={color} fillOpacity="0.8" />
          <circle cx="160" cy="84" r="2" fill={color} fillOpacity="0.8" />
          {/* Sideboard buffet against the back wall */}
          <rect x="90" y="46" width="140" height="16" rx="6" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.2)" />
          <circle cx="112" cy="54" r="1.6" fill="rgba(255,255,255,0.3)" />
          <circle cx="208" cy="54" r="1.6" fill="rgba(255,255,255,0.3)" />
        </>);
      case 'f1_study':
        return (<>
          <rect x="18" y="18" width="284" height="184" rx="24" fill="rgba(12,22,32,0.8)" />
          <rect x="36" y="38" width="248" height="144" rx="18" fill="rgba(255,255,255,0.04)" stroke={color} strokeWidth="1.2" strokeOpacity="0.75" />
          {/* Bookshelf with mixed-height spines */}
          <rect x="66" y="66" width="56" height="96" rx="9" fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.22)" />
          <path d="M66 94 H122 M66 122 H122 M66 148 H122" stroke="rgba(255,255,255,0.2)" />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <rect key={i} x={70 + i * 8} y={98} width="5.6" height="20" fill={color} fillOpacity={0.18 + (i % 4) * 0.09} />
          ))}
          {/* Writing desk with scattered papers + open drawer */}
          <rect x="138" y="112" width="104" height="44" rx="9" fill="rgba(255,255,255,0.09)" stroke={color} strokeWidth="1.2" />
          <path d="M156 104 L214 92 M160 120 L202 112 M168 132 L216 132" stroke="rgba(255,255,255,0.38)" strokeWidth="1.4" />
          <rect x="150" y="132" width="26" height="14" rx="2" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.2)" strokeWidth="0.8" />
          {/* Desk chair */}
          <rect x="176" y="160" width="24" height="16" rx="6" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.2)" />
          <path d="M180 160 V148 H196 V160" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1.4" />
          {/* Round window with a globe silhouette below */}
          <circle cx="224" cy="82" r="12" fill="rgba(92,122,153,0.18)" stroke={color} strokeWidth="1.2" />
          <path d="M212 82 H236 M224 70 V94" stroke={color} strokeWidth="0.6" strokeOpacity="0.6" />
          {/* Small rug under the desk */}
          <rect x="150" y="158" width="70" height="12" rx="6" fill="none" stroke={color} strokeWidth="0.8" strokeOpacity="0.4" strokeDasharray="3 3" />
        </>);
      case 'f1_cellar':
        return (<>
          <rect x="18" y="18" width="284" height="184" rx="24" fill="rgba(20,13,29,0.82)" />
          <rect x="36" y="38" width="248" height="144" rx="18" fill="rgba(255,255,255,0.035)" stroke={color} strokeWidth="1.2" strokeOpacity="0.75" />
          {/* Wine racks, three shelves deep */}
          <path d="M58 76 H262 M58 112 H262 M58 148 H262" stroke="rgba(255,255,255,0.2)" strokeWidth="2" />
          {[78, 110, 142, 174, 206, 238].map((x) => <g key={x}><ellipse cx={x} cy="92" rx="10" ry="15" fill="rgba(106,74,138,0.24)" stroke={color} strokeWidth="1" /><ellipse cx={x} cy="128" rx="10" ry="15" fill="rgba(106,74,138,0.24)" stroke={color} strokeWidth="1" /><circle cx={x} cy="80" r="2" fill={color} fillOpacity="0.6" /></g>)}
          {/* Stacked wooden crates in the corner */}
          <rect x="200" y="150" width="34" height="20" rx="2" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.22)" strokeWidth="1" />
          <rect x="204" y="132" width="26" height="18" rx="2" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.22)" strokeWidth="1" />
          <path d="M200 160 H234 M217 150 V170" stroke="rgba(255,255,255,0.16)" strokeWidth="0.8" />
          {/* Barrel */}
          <ellipse cx="80" cy="162" rx="16" ry="8" fill="rgba(106,74,138,0.16)" stroke={color} strokeWidth="1.2" />
          <path d="M64 156 Q80 150 96 156" fill="none" stroke={color} strokeWidth="0.8" strokeOpacity="0.6" />
          {/* Hanging lantern + cobweb in the corner */}
          <line x1="248" y1="40" x2="248" y2="62" stroke="rgba(255,255,255,0.24)" strokeWidth="1" />
          <circle cx="248" cy="68" r="7" fill="rgba(255,191,105,0.14)" stroke={color} strokeWidth="1" />
          <path d="M40 42 Q52 44 50 56 Q60 52 62 62" fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="0.8" />
          <path d="M62 164 H258" stroke="rgba(255,255,255,0.12)" strokeWidth="3" />
        </>);
      case 'f1_ballroom':
        return (<>
          <rect x="18" y="18" width="284" height="184" rx="24" fill="rgba(26,18,34,0.8)" />
          <rect x="36" y="38" width="248" height="144" rx="18" fill="rgba(255,255,255,0.04)" stroke={color} strokeWidth="1.2" strokeOpacity="0.75" />
          {/* Mirrored parquet floor with a medallion pattern radiating from center */}
          <path d="M68 154 L160 72 L252 154 M92 166 L160 94 L228 166 M160 72 V46" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="1.3" />
          <circle cx="160" cy="130" r="30" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="0.8" strokeDasharray="2 4" />
          {/* Chandelier */}
          <circle cx="160" cy="66" r="14" fill="rgba(201,168,216,0.15)" stroke={color} strokeWidth="1.3" />
          <circle cx="152" cy="64" r="1.8" fill={color} fillOpacity="0.8" />
          <circle cx="168" cy="64" r="1.8" fill={color} fillOpacity="0.8" />
          <circle cx="160" cy="58" r="1.8" fill={color} fillOpacity="0.8" />
          <path d="M82 156 H238 M160 96 V170 M110 130 H210" stroke="rgba(255,255,255,0.16)" strokeWidth="1" />
          {/* Grand piano in the corner */}
          <path d="M62 150 Q52 130 70 118 L96 118 L96 150 Z" fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.24)" strokeWidth="1.2" />
          <rect x="62" y="150" width="34" height="6" rx="2" fill="rgba(255,255,255,0.1)" />
          {/* Tall curtains flanking the far wall */}
          <path d="M244 46 Q252 90 244 134 M244 46 Q236 90 244 134" fill="none" stroke={color} strokeWidth="0.9" strokeOpacity="0.5" />
        </>);
      case 'f1_kitchen':
        return (
          <>
            <rect x="18" y="18" width="284" height="184" rx="24" fill="rgba(24,14,11,0.78)" />
            <rect x="40" y="36" width="240" height="148" rx="20" fill="rgba(255,255,255,0.04)" stroke={color} strokeWidth="1.2" strokeOpacity="0.75" />
            <rect x="54" y="54" width="212" height="116" rx="20" fill="url(#floorKitchen)" stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
            {/* Counter with a cutting board and knife block */}
            <rect x="74" y="70" width="88" height="70" rx="12" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.24)" />
            <rect x="82" y="76" width="24" height="14" rx="2" fill="rgba(255,255,255,0.1)" stroke="rgba(255,255,255,0.24)" strokeWidth="0.8" />
            <path d="M114 78 L120 92 M118 78 L124 92 M122 78 L128 92" stroke="rgba(255,255,255,0.3)" strokeWidth="1.2" />
            {/* Stove island with a lit burner and overhead pot rack */}
            <rect x="188" y="66" width="60" height="74" rx="12" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.24)" />
            <path d="M112 96 H148" stroke={color} strokeWidth="2" strokeOpacity="0.9" />
            <circle cx="116" cy="94" r="20" fill="rgba(255,255,255,0.05)" stroke={color} strokeWidth="1.2" />
            <circle cx="204" cy="82" r="6" fill="rgba(255,120,80,0.24)" stroke={color} strokeWidth="1" />
            <circle cx="228" cy="82" r="6" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.28)" strokeWidth="1" />
            {/* Hanging pot rack with three pans */}
            <line x1="196" y1="40" x2="240" y2="40" stroke="rgba(255,255,255,0.26)" strokeWidth="1.4" />
            <path d="M210 80 H228" stroke={color} strokeWidth="1.6" />
            <path d="M210 100 H228" stroke={color} strokeWidth="1.6" />
            <path d="M210 120 H228" stroke={color} strokeWidth="1.6" />
            <ellipse cx="204" cy="46" rx="6" ry="2.4" fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth="1" />
            <ellipse cx="222" cy="46" rx="6" ry="2.4" fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth="1" />
            <line x1="204" y1="40" x2="204" y2="44" stroke="rgba(255,255,255,0.24)" strokeWidth="1" />
            <line x1="222" y1="40" x2="222" y2="44" stroke="rgba(255,255,255,0.24)" strokeWidth="1" />
            {/* Small round kitchen table */}
            <ellipse cx="130" cy="160" rx="26" ry="8" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.22)" strokeWidth="1" />
            <rect x="72" y="148" width="146" height="16" rx="8" fill="rgba(255,255,255,0.05)" />
          </>
        );
      case 'f1_garage':
        return (<>
          <rect x="18" y="18" width="284" height="184" rx="24" fill="rgba(12,20,25,0.82)" />
          <rect x="36" y="38" width="248" height="144" rx="18" fill="rgba(255,255,255,0.04)" stroke={color} strokeWidth="1.2" strokeOpacity="0.75" />
          {/* Pegboard wall with hanging tool silhouettes */}
          <path d="M52 60 H268 M52 70 H268 M52 80 H268" stroke="rgba(255,255,255,0.14)" strokeWidth="1" />
          <path d="M64 62 V78 M64 78 L58 88" stroke="rgba(255,255,255,0.3)" strokeWidth="1.6" />
          <circle cx="90" cy="70" r="9" fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth="1.4" />
          <path d="M116 62 L128 62 L128 80 L116 80 Z" fill="none" stroke="rgba(255,255,255,0.26)" strokeWidth="1.2" />
          {/* Idle car with headlights and wheels */}
          <path d="M76 150 L90 112 Q102 100 126 100 H194 Q218 100 230 112 L244 150 Z" fill="rgba(85,107,122,0.18)" stroke={color} strokeWidth="1.8" />
          <rect x="96" y="106" width="30" height="16" rx="4" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.2)" strokeWidth="0.8" />
          <rect x="194" y="106" width="30" height="16" rx="4" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.2)" strokeWidth="0.8" />
          <circle cx="86" cy="130" r="3" fill="rgba(255,255,255,0.3)" />
          <circle cx="234" cy="130" r="3" fill="rgba(255,220,120,0.4)" />
          <circle cx="112" cy="150" r="14" fill="rgba(0,0,0,0.32)" stroke="rgba(255,255,255,0.4)" strokeWidth="2" />
          <circle cx="208" cy="150" r="14" fill="rgba(0,0,0,0.32)" stroke="rgba(255,255,255,0.4)" strokeWidth="2" />
          {/* Workbench with a vice, tucked beside the car */}
          <rect x="244" y="140" width="36" height="14" rx="2" fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.22)" strokeWidth="1" />
          <path d="M252 136 H262 M254 132 V140 M260 132 V140" stroke="rgba(255,255,255,0.24)" strokeWidth="1.2" />
          {/* Oil can + stacked tire beside the bench */}
          <ellipse cx="62" cy="164" rx="9" ry="6" fill="none" stroke="rgba(255,255,255,0.24)" strokeWidth="1.4" />
          <ellipse cx="62" cy="156" rx="9" ry="6" fill="none" stroke="rgba(255,255,255,0.24)" strokeWidth="1.4" />
          <path d="M70 172 H250" stroke="rgba(255,255,255,0.14)" strokeWidth="3" strokeDasharray="10 8" />
        </>);
      case 'f1_holding_cell':
        return (<>
          <rect x="18" y="18" width="284" height="184" rx="24" fill="rgba(30,10,12,0.84)" />
          <rect x="36" y="38" width="248" height="144" rx="18" fill="rgba(255,255,255,0.035)" stroke={color} strokeWidth="1.2" strokeOpacity="0.75" />
          <rect x="84" y="56" width="152" height="112" rx="10" fill="rgba(0,0,0,0.22)" stroke="rgba(255,255,255,0.25)" />
          {[104, 128, 152, 176, 200].map((x) => <line key={x} x1={x} y1="56" x2={x} y2="168" stroke={color} strokeWidth="3" strokeOpacity="0.78" />)}
          {/* Bare cot along the back wall */}
          <rect x="94" y="142" width="52" height="14" rx="3" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
          <path d="M94 142 V156" stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
          {/* Floor drain */}
          <circle cx="200" cy="150" r="5" fill="rgba(0,0,0,0.4)" stroke="rgba(255,255,255,0.2)" strokeWidth="0.8" />
          <path d="M197 148 L203 152 M203 148 L197 152" stroke="rgba(255,255,255,0.16)" strokeWidth="0.6" />
          {/* Chained shackle on the wall */}
          <circle cx="220" cy="76" r="4" fill="none" stroke="rgba(255,255,255,0.26)" strokeWidth="1.2" />
          <path d="M220 80 Q216 90 220 98" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1" />
          {/* Active lock indicator light */}
          <rect x="148" y="96" width="24" height="18" rx="3" fill="rgba(224,82,74,0.24)" stroke={color} strokeWidth="1.2" />
          <circle cx="160" cy="105" r="3" fill={color} />
        </>);
      case 'f1_armory':
        return (
          <>
            <rect x="18" y="18" width="284" height="184" rx="24" fill="rgba(18,18,18,0.78)" />
            <rect x="34" y="38" width="252" height="144" rx="20" fill="rgba(255,255,255,0.04)" stroke={color} strokeWidth="1.2" strokeOpacity="0.75" />
            <rect x="54" y="54" width="212" height="116" rx="18" fill="url(#floorArmory)" stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
            {/* Crossed blades mounted above a shield emblem */}
            <path d="M88 76 L120 58" stroke={color} strokeWidth="2.2" />
            <path d="M232 76 L202 58" stroke={color} strokeWidth="2.2" />
            <path d="M148 48 L160 42 L172 48 L172 62 L160 70 L148 62 Z" fill="rgba(255,255,255,0.06)" stroke={color} strokeWidth="1.2" />
            {/* Weapon display cabinets, each with a rack of blade silhouettes */}
            <rect x="82" y="80" width="56" height="78" rx="10" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.24)" />
            <rect x="182" y="80" width="56" height="78" rx="10" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.24)" />
            <path d="M96 94 L96 144 M110 90 L110 148 M124 94 L124 144" stroke="rgba(255,255,255,0.22)" strokeWidth="1.2" />
            <path d="M196 94 L196 144 M210 90 L210 148 M224 94 L224 144" stroke="rgba(255,255,255,0.22)" strokeWidth="1.2" />
            <path d="M100 136 L112 110" stroke={color} strokeWidth="2" />
            <path d="M220 136 L208 110" stroke={color} strokeWidth="2" />
            {/* Ammunition crate on the floor */}
            <rect x="148" y="140" width="28" height="18" rx="2" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.22)" strokeWidth="1" />
            <path d="M148 149 H176" stroke="rgba(255,255,255,0.16)" strokeWidth="0.8" />
            <path d="M140 70 H180" stroke="rgba(255,255,255,0.24)" strokeWidth="2" />
          </>
        );
      case 'f2_master':
        return (
          <>
            <rect x="18" y="18" width="284" height="184" rx="24" fill="rgba(26,19,30,0.76)" />
            <rect x="34" y="36" width="252" height="148" rx="20" fill="rgba(255,255,255,0.04)" stroke={color} strokeWidth="1.2" strokeOpacity="0.75" />
            <rect x="56" y="52" width="208" height="118" rx="18" fill="url(#floorBedroom)" stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
            {/* Four-poster bed with posts, headboard and pillows */}
            <line x1="90" y1="60" x2="90" y2="146" stroke="rgba(255,255,255,0.26)" strokeWidth="1.6" />
            <line x1="186" y1="60" x2="186" y2="146" stroke="rgba(255,255,255,0.26)" strokeWidth="1.6" />
            <path d="M90 60 H186" stroke="rgba(255,255,255,0.2)" strokeWidth="1.2" />
            <rect x="90" y="76" width="96" height="70" rx="16" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.24)" />
            <rect x="96" y="82" width="84" height="14" rx="6" fill="rgba(255,255,255,0.1)" />
            <ellipse cx="112" cy="88" rx="12" ry="6" fill="rgba(255,255,255,0.14)" />
            <ellipse cx="164" cy="88" rx="12" ry="6" fill="rgba(255,255,255,0.14)" />
            {/* Nightstand with a small lamp */}
            <rect x="198" y="74" width="44" height="70" rx="10" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.24)" />
            <path d="M220 62 L212 74 H228 Z" fill="rgba(255,220,150,0.16)" stroke={color} strokeWidth="1" />
            <line x1="220" y1="62" x2="220" y2="54" stroke="rgba(255,255,255,0.24)" strokeWidth="1" />
            {/* Dresser with an oval mirror */}
            <rect x="82" y="126" width="40" height="22" rx="10" fill="rgba(255,255,255,0.06)" />
            <ellipse cx="102" cy="118" rx="10" ry="14" fill="rgba(255,255,255,0.05)" stroke={color} strokeWidth="1" />
            <rect x="196" y="126" width="24" height="14" rx="7" fill="rgba(255,255,255,0.06)" />
            <path d="M88 146 H190" stroke="rgba(255,255,255,0.16)" strokeWidth="2" />
          </>
        );
      case 'f2_bath':
        return (
          <>
            <rect x="18" y="18" width="284" height="184" rx="24" fill="rgba(15,24,32,0.8)" />
            <rect x="36" y="40" width="248" height="142" rx="20" fill="rgba(255,255,255,0.04)" stroke={color} strokeWidth="1.2" strokeOpacity="0.75" />
            <rect x="56" y="58" width="208" height="108" rx="24" fill="url(#floorBath)" stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
            {/* Tiled wall pattern behind the tub */}
            <path d="M92 60 H228 M92 76 H228 M92 92 H228 M108 60 V96 M124 60 V96 M140 60 V96 M156 60 V96 M172 60 V96 M188 60 V96 M204 60 V96" stroke="rgba(255,255,255,0.08)" strokeWidth="0.7" />
            {/* Claw-foot tub with faucet */}
            <rect x="92" y="78" width="136" height="74" rx="24" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.24)" />
            <rect x="110" y="70" width="100" height="20" rx="10" fill="rgba(255,255,255,0.10)" />
            <path d="M118 74 Q118 66 128 66" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="1.4" />
            {/* Mirror above a small vanity shelf with bottles */}
            <circle cx="160" cy="106" r="24" fill="rgba(255,255,255,0.05)" stroke={color} strokeWidth="1.3" />
            <rect x="230" y="112" width="26" height="6" rx="2" fill="rgba(255,255,255,0.1)" stroke="rgba(255,255,255,0.24)" strokeWidth="0.6" />
            <rect x="233" y="102" width="4" height="10" rx="1" fill="rgba(154,168,184,0.3)" />
            <rect x="240" y="100" width="4" height="12" rx="1" fill="rgba(154,168,184,0.24)" />
            <rect x="247" y="104" width="4" height="8" rx="1" fill="rgba(154,168,184,0.28)" />
            {/* Bath mat on the floor */}
            <rect x="112" y="148" width="96" height="10" rx="5" fill="none" stroke={color} strokeWidth="0.8" strokeOpacity="0.4" strokeDasharray="3 3" />
            <path d="M112 148 H208" stroke="rgba(255,255,255,0.16)" strokeWidth="2" />
          </>
        );
      case 'f2_guest':
        return (<>
          <rect x="18" y="18" width="284" height="184" rx="24" fill="rgba(18,22,26,0.8)" />
          <rect x="36" y="38" width="248" height="144" rx="18" fill="rgba(255,255,255,0.04)" stroke={color} strokeWidth="1.2" strokeOpacity="0.75" />
          {/* Simple bed with a folded blanket and pillow */}
          <rect x="76" y="88" width="132" height="64" rx="13" fill="rgba(255,255,255,0.09)" stroke="rgba(255,255,255,0.25)" />
          <rect x="86" y="78" width="48" height="24" rx="8" fill="rgba(255,255,255,0.13)" />
          <rect x="150" y="120" width="46" height="16" rx="4" fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.2)" strokeWidth="0.8" />
          {/* Nightstand with a small lamp */}
          <rect x="198" y="112" width="42" height="34" rx="7" fill="rgba(154,168,184,0.18)" stroke={color} strokeWidth="1.2" />
          <path d="M219 100 L212 112 H226 Z" fill="rgba(255,220,150,0.14)" stroke={color} strokeWidth="0.9" />
          {/* Unpacked suitcase leaning by the wall */}
          <rect x="52" y="140" width="30" height="22" rx="4" fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.24)" strokeWidth="1" transform="rotate(-8 67 151)" />
          <path d="M56 148 H78" stroke="rgba(255,255,255,0.2)" strokeWidth="1" transform="rotate(-8 67 151)" />
          {/* Curtain on the window side */}
          <path d="M254 46 Q262 90 254 134" fill="none" stroke={color} strokeWidth="0.9" strokeOpacity="0.5" />
          <path d="M76 156 H208 M92 156 V170 M192 156 V170" stroke="rgba(255,255,255,0.2)" strokeWidth="2" />
        </>);
      case 'f2_nursery':
        return (<>
          <rect x="18" y="18" width="284" height="184" rx="24" fill="rgba(33,28,12,0.8)" />
          <rect x="36" y="38" width="248" height="144" rx="18" fill="rgba(255,255,255,0.04)" stroke={color} strokeWidth="1.2" strokeOpacity="0.75" />
          {/* Crib with slat rails, rocking gently */}
          <path d="M86 146 Q160 176 234 146 M94 146 L110 96 M226 146 L210 96 M110 96 Q160 60 210 96" fill="none" stroke={color} strokeWidth="2" />
          <path d="M118 96 V144 M132 96 V144 M146 96 V144 M174 96 V144 M188 96 V144 M202 96 V144" stroke="rgba(255,255,255,0.16)" strokeWidth="1" />
          <path d="M108 126 H212" stroke="rgba(255,255,255,0.2)" strokeWidth="2" />
          {/* Mobile with hanging stars above the crib */}
          <circle cx="116" cy="82" r="5" fill={color} fillOpacity="0.72" />
          <circle cx="204" cy="82" r="5" fill={color} fillOpacity="0.72" />
          <circle cx="160" cy="72" r="6" fill="rgba(255,255,255,0.12)" stroke={color} strokeWidth="1" />
          <path d="M116 76 V82 M204 76 V82 M160 66 V72" stroke="rgba(255,255,255,0.2)" strokeWidth="0.8" />
          {/* Small teddy bear beside the crib */}
          <circle cx="70" cy="156" r="8" fill="rgba(224,185,106,0.24)" stroke={color} strokeWidth="1" />
          <circle cx="64" cy="148" r="3.5" fill="rgba(224,185,106,0.24)" stroke={color} strokeWidth="0.8" />
          <circle cx="76" cy="148" r="3.5" fill="rgba(224,185,106,0.24)" stroke={color} strokeWidth="0.8" />
          {/* Scattered toy blocks */}
          <rect x="238" y="152" width="10" height="10" rx="2" fill="rgba(224,185,106,0.2)" stroke={color} strokeWidth="0.8" transform="rotate(10 243 157)" />
          <rect x="250" y="156" width="10" height="10" rx="2" fill="rgba(224,185,106,0.16)" stroke={color} strokeWidth="0.8" transform="rotate(-6 255 161)" />
        </>);
      case 'f2_office':
        return (
          <>
            <rect x="18" y="18" width="284" height="184" rx="24" fill="rgba(14,18,24,0.78)" />
            <rect x="34" y="40" width="252" height="142" rx="20" fill="rgba(255,255,255,0.04)" stroke={color} strokeWidth="1.2" strokeOpacity="0.75" />
            <rect x="56" y="56" width="208" height="110" rx="18" fill="url(#floorOffice)" stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
            {/* Desk with a monitor still glowing */}
            <rect x="76" y="74" width="124" height="74" rx="10" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.24)" />
            <rect x="100" y="64" width="40" height="26" rx="3" fill="rgba(110,138,201,0.22)" stroke={color} strokeWidth="1.1" />
            <line x1="120" y1="90" x2="120" y2="96" stroke="rgba(255,255,255,0.2)" strokeWidth="1.2" />
            <path d="M86 150 H184" stroke="rgba(255,255,255,0.16)" strokeWidth="2" />
            {/* Locked filing cabinet */}
            <rect x="214" y="72" width="32" height="40" rx="8" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.24)" />
            <rect x="214" y="120" width="32" height="18" rx="8" fill="rgba(255,255,255,0.06)" />
            <circle cx="220" cy="92" r="8" fill="rgba(255,255,255,0.1)" stroke={color} strokeWidth="1.2" />
            {/* Desk chair with a rounded back */}
            <path d="M96 150 V172 M96 172 Q96 178 102 178 H108 Q114 178 114 172 V150" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.4" />
            {/* Small potted plant + wall clock */}
            <ellipse cx="256" cy="150" rx="8" ry="4" fill="rgba(76,175,125,0.2)" stroke={color} strokeWidth="0.9" />
            <path d="M256 150 Q250 142 246 146 M256 150 Q262 140 266 144" fill="none" stroke={color} strokeWidth="0.8" strokeOpacity="0.6" />
            <circle cx="70" cy="58" r="7" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.24)" strokeWidth="1" />
            <line x1="70" y1="58" x2="70" y2="54" stroke="rgba(255,255,255,0.3)" strokeWidth="0.8" />
            <line x1="70" y1="58" x2="73" y2="59" stroke="rgba(255,255,255,0.3)" strokeWidth="0.8" />
          </>
        );
      case 'f2_gallery':
        return (
          <>
            <rect x="18" y="18" width="284" height="184" rx="24" fill="rgba(24,16,10,0.78)" />
            <rect x="34" y="40" width="252" height="142" rx="20" fill="rgba(255,255,255,0.04)" stroke={color} strokeWidth="1.2" strokeOpacity="0.75" />
            <rect x="54" y="58" width="212" height="110" rx="18" fill="url(#floorGallery)" stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
            {/* Three framed portraits, each with an inner mat border */}
            <rect x="76" y="74" width="44" height="72" rx="10" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.24)" />
            <rect x="83" y="81" width="30" height="58" rx="4" fill="rgba(255,255,255,0.05)" stroke={color} strokeWidth="0.8" strokeOpacity="0.5" />
            <rect x="138" y="74" width="44" height="72" rx="10" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.24)" />
            <rect x="145" y="81" width="30" height="58" rx="4" fill="rgba(255,255,255,0.05)" stroke={color} strokeWidth="0.8" strokeOpacity="0.5" />
            <rect x="200" y="74" width="44" height="72" rx="10" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.24)" />
            <rect x="207" y="81" width="30" height="58" rx="4" fill="rgba(255,255,255,0.05)" stroke={color} strokeWidth="0.8" strokeOpacity="0.5" />
            {/* Small wall sconce lights above each frame */}
            <circle cx="98" cy="110" r="7" fill={color} fillOpacity="0.7" />
            <circle cx="160" cy="110" r="7" fill={color} fillOpacity="0.7" />
            <circle cx="222" cy="110" r="7" fill={color} fillOpacity="0.7" />
            {/* Center ottoman bench for viewing */}
            <ellipse cx="160" cy="156" rx="24" ry="9" fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.22)" strokeWidth="1" />
            <path d="M70 152 H250" stroke="rgba(255,255,255,0.16)" strokeWidth="2" />
          </>
        );
      case 'f2_archive':
        return (<>
          <rect x="18" y="18" width="284" height="184" rx="24" fill="rgba(24,24,13,0.8)" />
          <rect x="36" y="38" width="248" height="144" rx="18" fill="rgba(255,255,255,0.04)" stroke={color} strokeWidth="1.2" strokeOpacity="0.75" />
          {/* Filing cabinets with drawer handles */}
          {[72, 132, 192].map((x) => <g key={x}><rect x={x} y="66" width="40" height="92" rx="7" fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.22)" /><path d={`M${x} 94 H${x + 40} M${x} 122 H${x + 40}`} stroke="rgba(255,255,255,0.2)" /><circle cx={x + 20} cy="80" r="1.4" fill="rgba(255,255,255,0.3)" /><circle cx={x + 20} cy="108" r="1.4" fill="rgba(255,255,255,0.3)" /><circle cx={x + 20} cy="140" r="1.4" fill="rgba(255,255,255,0.3)" /></g>)}
          {/* One forced-open drawer with papers spilling out */}
          <rect x="200" y="130" width="30" height="18" rx="3" fill="rgba(138,138,92,0.22)" stroke={color} strokeWidth="1" transform="rotate(-12 215 139)" />
          <path d="M204 148 L198 158 M212 150 L210 160 M220 149 L222 159" stroke="rgba(255,255,255,0.2)" strokeWidth="0.9" />
          {/* Stacked storage boxes on the floor */}
          <rect x="240" y="140" width="24" height="18" rx="2" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
          <rect x="242" y="122" width="20" height="16" rx="2" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
          {/* Bare bulb hanging from the ceiling */}
          <line x1="60" y1="40" x2="60" y2="58" stroke="rgba(255,255,255,0.24)" strokeWidth="1" />
          <circle cx="60" cy="64" r="6" fill="rgba(255,255,255,0.1)" stroke={color} strokeWidth="1" />
        </>);
      case 'f2_terrace':
        return (<>
          <rect x="18" y="18" width="284" height="184" rx="24" fill="rgba(8,15,25,0.84)" />
          <rect x="36" y="38" width="248" height="144" rx="18" fill="rgba(255,255,255,0.035)" stroke={color} strokeWidth="1.2" strokeOpacity="0.75" />
          {/* Storm moon */}
          <circle cx="226" cy="74" r="24" fill="rgba(74,106,138,0.18)" stroke={color} strokeWidth="1.2" />
          {/* Stone balustrade railing */}
          <path d="M62 148 H258 M72 148 V112 M96 148 V112 M120 148 V112 M144 148 V112 M168 148 V112 M192 148 V112 M216 148 V112 M240 148 V112" stroke="rgba(255,255,255,0.3)" strokeWidth="2" />
          {/* Bistro table and chair against the rail */}
          <ellipse cx="96" cy="150" rx="14" ry="5" fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.22)" strokeWidth="1" />
          <line x1="96" y1="150" x2="96" y2="160" stroke="rgba(255,255,255,0.2)" strokeWidth="1.6" />
          <path d="M78 158 V172 M78 172 Q78 176 82 176 H86 Q90 176 90 172 V158" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1.2" />
          {/* Potted plant weathering the storm */}
          <ellipse cx="232" cy="150" rx="10" ry="5" fill="rgba(76,175,125,0.16)" stroke={color} strokeWidth="0.9" />
          <path d="M232 150 Q224 140 218 146 M232 150 Q240 138 246 144" fill="none" stroke={color} strokeWidth="0.9" strokeOpacity="0.5" />
          {/* Storm clouds swallowing the grounds below */}
          <path d="M62 164 Q112 144 160 164 T258 164" fill="none" stroke={color} strokeWidth="1.6" strokeOpacity="0.7" />
        </>);
      case 'f2_attic':
        return (
          <>
            <rect x="18" y="18" width="284" height="184" rx="24" fill="rgba(22,20,20,0.78)" />
            <rect x="34" y="40" width="252" height="142" rx="20" fill="rgba(255,255,255,0.04)" stroke={color} strokeWidth="1.2" strokeOpacity="0.75" />
            <rect x="56" y="58" width="208" height="110" rx="18" fill="url(#floorAttic)" stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
            {/* Exposed roof beams */}
            <path d="M92 150 L142 84 L178 150" stroke={color} strokeWidth="2.2" fill="none" />
            <path d="M108 128 L166 128" stroke={color} strokeWidth="1" strokeOpacity="0.5" />
            {/* Dust-sheeted furniture shape under a cloth */}
            <rect x="196" y="86" width="46" height="56" rx="8" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.24)" />
            <path d="M196 100 Q219 92 242 100" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
            {/* Old steamer trunk */}
            <rect x="80" y="84" width="40" height="38" rx="8" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.2)" />
            <path d="M80 96 H120" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
            <rect x="94" y="88" width="12" height="6" rx="2" fill="rgba(255,255,255,0.1)" />
            {/* Rocking horse silhouette */}
            <path d="M240 158 Q246 140 258 142 Q262 128 254 122 Q248 132 246 140 Q234 138 232 150 Q228 158 240 158 Z" fill="none" stroke={color} strokeWidth="1.2" strokeOpacity="0.7" />
            <path d="M232 158 Q248 150 262 158" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
            {/* Cobweb in the far corner */}
            <path d="M258 44 Q268 48 266 58 Q276 54 278 64" fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="0.8" />
            <path d="M110 150 V120" stroke="rgba(255,255,255,0.14)" strokeWidth="2" />
          </>
        );
      case 'f2_observatory':
        return (
          <>
            <rect x="18" y="18" width="284" height="184" rx="24" fill="rgba(10,14,26,0.82)" />
            <rect x="34" y="40" width="252" height="142" rx="20" fill="rgba(255,255,255,0.04)" stroke={color} strokeWidth="1.2" strokeOpacity="0.75" />
            <rect x="56" y="58" width="208" height="110" rx="18" fill="url(#floorObservatory)" stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
            {/* Shattered dome skylight with scattered stars beyond it */}
            <circle cx="160" cy="104" r="34" fill="rgba(255,255,255,0.06)" stroke={color} strokeWidth="1.4" />
            <path d="M132 78 L188 130" stroke={color} strokeWidth="2" />
            <path d="M132 130 L188 78" stroke={color} strokeWidth="2" />
            {[[100, 62], [220, 70], [96, 140], [232, 128], [154, 50]].map(([sx, sy], i) => (
              <circle key={i} cx={sx} cy={sy} r="1.4" fill="rgba(255,255,255,0.6)" />
            ))}
            {/* Telescope on a tripod, angled toward the dome */}
            <path d="M182 150 L150 96" stroke="rgba(255,255,255,0.3)" strokeWidth="4" strokeLinecap="round" />
            <path d="M182 150 L172 168 M182 150 L192 166 M182 150 L182 172" stroke="rgba(255,255,255,0.24)" strokeWidth="1.4" />
            {/* Star chart desk beneath the dome */}
            <rect x="90" y="144" width="140" height="14" rx="7" fill="rgba(255,255,255,0.06)" />
            <path d="M104 148 L112 152 L120 147 L128 152" fill="none" stroke={color} strokeWidth="0.8" strokeOpacity="0.6" />
          </>
        );
      case 'b_torture':
        return (
          <>
            <rect x="18" y="18" width="284" height="184" rx="24" fill="rgba(20,7,7,0.86)" />
            <rect x="34" y="36" width="252" height="148" rx="20" fill="rgba(255,255,255,0.03)" stroke={color} strokeWidth="1.2" strokeOpacity="0.75" />
            {/* Cracked stone floor tiles */}
            <path d="M50 150 H270 M50 168 H270 M90 150 V184 M170 150 V184 M230 150 V184" stroke="rgba(255,255,255,0.06)" strokeWidth="0.8" />
            <line x1="160" y1="36" x2="160" y2="76" stroke={color} strokeWidth="2.2" />
            <path d="M144 76 H176 L166 100 H154 Z" fill="rgba(255,255,255,0.05)" stroke={color} strokeWidth="1.4" />
            <line x1="154" y1="100" x2="146" y2="150" stroke="rgba(255,255,255,0.2)" strokeWidth="1.6" />
            <line x1="166" y1="100" x2="174" y2="150" stroke="rgba(255,255,255,0.2)" strokeWidth="1.6" />
            <circle cx="160" cy="162" r="12" fill="rgba(0,0,0,0.3)" stroke={color} strokeWidth="1.6" />
            {/* Wall-mounted shackles either side of the chain */}
            <circle cx="90" cy="60" r="4" fill="none" stroke="rgba(255,255,255,0.24)" strokeWidth="1.2" />
            <path d="M90 64 Q86 74 90 82" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
            <circle cx="230" cy="60" r="4" fill="none" stroke="rgba(255,255,255,0.24)" strokeWidth="1.2" />
            <path d="M230 64 Q234 74 230 82" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
            {/* Small table of implements against the wall */}
            <rect x="52" y="146" width="30" height="10" rx="2" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.18)" strokeWidth="0.8" />
            <line x1="58" y1="146" x2="58" y2="140" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
            <line x1="70" y1="146" x2="72" y2="138" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
            <path d="M60 180 H130" stroke="rgba(255,255,255,0.12)" strokeWidth="2" strokeDasharray="3 5" />
            <path d="M190 180 H260" stroke="rgba(255,255,255,0.12)" strokeWidth="2" strokeDasharray="3 5" />
          </>
        );
      default:
        return (
          <>
            <rect x="18" y="18" width="284" height="184" rx="24" fill="rgba(15,16,20,0.78)" />
            <rect x="34" y="36" width="252" height="148" rx="20" fill="rgba(255,255,255,0.04)" stroke={color} strokeWidth="1.2" strokeOpacity="0.75" />
            <rect x="56" y="58" width="208" height="104" rx="18" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.2)" />
            <circle cx="160" cy="110" r="28" fill="rgba(255,255,255,0.06)" stroke={color} strokeWidth="1.3" />
            <path d="M132 136 H188" stroke="rgba(255,255,255,0.16)" strokeWidth="2" />
          </>
        );
    }
  };

  return (
    <div style={{
      position: 'relative', width: '100%', height: '100%', minWidth: 0, minHeight: 0,
      display: 'grid', overflow: 'hidden', borderRadius: '14px', isolation: 'isolate'
    }}>
      {/* Photo backdrop rendered as a real <img> (not inside the SVG's fixed
          320x220 viewBox) so it always covers the container edge-to-edge via
          object-fit: cover, regardless of the container's own aspect ratio —
          the SVG's viewBox scaling ("meet") would otherwise letterbox it and
          leave empty bars on the sides. */}
      {roomImage && (
        <img
          src={roomImage}
          alt=""
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%',
            objectFit: 'cover', objectPosition: 'center', zIndex: 0
          }}
        />
      )}
      <svg viewBox={`0 0 ${sceneWidth} ${sceneHeight}`} xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" style={{ display: 'block', width: '100%', height: '100%', minWidth: 0, minHeight: 0, position: 'relative', zIndex: 1 }}>
        <defs>
          <filter id="roomGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feColorMatrix in="blur" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0.18 0" />
          </filter>
          <radialGradient id="roomLightSource" cx="50%" cy="30%" r="65%">
            <stop offset="0%" stopColor={color} stopOpacity="0.32" />
            <stop offset="55%" stopColor={color} stopOpacity="0.08" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </radialGradient>
          <radialGradient id="roomVignette" cx="50%" cy="50%" r="70%">
            <stop offset="55%" stopColor="rgba(0,0,0,0)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.55)" />
          </radialGradient>
          <linearGradient id={`floorHall`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.16)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.28)" />
          </linearGradient>
          <linearGradient id={`floorLibrary`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.16)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.24)" />
          </linearGradient>
          <linearGradient id={`floorKitchen`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.16)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.24)" />
          </linearGradient>
          <linearGradient id={`floorArmory`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.12)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.3)" />
          </linearGradient>
          <linearGradient id={`floorBedroom`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.16)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.24)" />
          </linearGradient>
          <linearGradient id={`floorBath`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.2)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.26)" />
          </linearGradient>
          <linearGradient id={`floorOffice`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.16)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.24)" />
          </linearGradient>
          <linearGradient id={`floorGallery`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.16)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.24)" />
          </linearGradient>
          <linearGradient id={`floorAttic`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.14)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.28)" />
          </linearGradient>
          <linearGradient id={`floorObservatory`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.16)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.24)" />
          </linearGradient>
        </defs>
        {roomImage ? null : (
          <>
            <ellipse cx="160" cy="190" rx="88" ry="18" fill="rgba(0,0,0,0.36)" filter="url(#roomGlow)" />
            <rect x="42" y="28" width="236" height="152" rx="22" fill="rgba(255,255,255,0.025)" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
            {renderScene()}
          </>
        )}
        {/* Flickering ambient light source — a soft radial wash in the room's
            accent color, gently pulsing in opacity to suggest a live, unstable
            light (candle/bulb/storm-glow) rather than a flat static render. */}
        <rect x="0" y="0" width={sceneWidth} height={sceneHeight} fill="url(#roomLightSource)" style={{ animation: 'roomLightFlicker 6.5s ease-in-out infinite', mixBlendMode: 'screen' }} />
        {/* Vignette: darkens the corners so occupant avatars and scene props
            read as sitting inside a lit space rather than floating on a flat
            card, and gently breathes to avoid looking static. */}
        <rect x="0" y="0" width={sceneWidth} height={sceneHeight} fill="url(#roomVignette)" style={{ animation: 'roomVignettePulse 9s ease-in-out infinite' }} />
      </svg>

      {/* Ambient dust motes drifting slowly through the room — purely
          atmospheric, deterministic per roomId (see dustMotes above) so it
          doesn't reshuffle on every re-render or differ between clients. */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
        {dustMotes.map(mote => (
          <div
            key={mote.id}
            style={{
              position: 'absolute',
              left: `${mote.left}%`,
              top: `${mote.top}%`,
              width: `${mote.size}px`,
              height: `${mote.size}px`,
              borderRadius: '50%',
              background: color,
              boxShadow: `0 0 ${mote.size * 2}px ${color}`,
              '--dust-x': `${mote.driftX}px`,
              '--dust-y': `${mote.driftY}px`,
              '--dust-opacity': mote.opacity,
              animation: `roomDustDrift ${mote.duration}s ease-in-out ${mote.delay}s infinite`
            }}
          />
        ))}
      </div>

      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {(() => {
          let newArrivalIndex = 0;
          return entities.map((entity, index) => {
            const pos = getOccupantPosition(entity);
            const avatarUrl = getCharacterUrl(entity.character);
            const isBody = entity.isBody;
            const entityId = getEntityId(entity) || index;
            const isNewArrival = newlyPlacedIds.has(getEntityId(entity));
            const animationDelay = isNewArrival ? newArrivalIndex++ * 80 : 0;
            return (
              <div
                key={entityId}
                style={{
                  position: 'absolute',
                  left: `${pos.x}%`,
                  top: `${pos.y}%`,
                  width: 'clamp(44px, 16vw, 84px)',
                  height: 'clamp(44px, 16vw, 84px)',
                  transform: 'translate(-50%, -50%)',
                  zIndex: 5,
                  ...(isNewArrival
                    ? { opacity: 0, animation: `occupantEnter 420ms cubic-bezier(0.16, 1, 0.3, 1) ${animationDelay}ms forwards` }
                    : { opacity: 1 })
                }}
              >
              <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                <div style={{
                  width: '100%',
                  height: '100%',
                  borderRadius: '50%',
                  overflow: 'hidden',
                  border: isBody ? '4px solid rgba(255,42,95,0.9)' : '4px solid rgba(255,255,255,0.95)',
                  boxShadow: isBody
                    ? '0 18px 36px rgba(0,0,0,0.5), 0 0 22px rgba(255,42,95,0.55), inset 0 0 0 2px rgba(255,42,95,0.3)'
                    : '0 18px 36px rgba(0,0,0,0.48), inset 0 0 0 2px rgba(255,255,255,0.24)',
                  background: isBody ? 'linear-gradient(135deg, rgba(120,0,30,0.4) 0%, rgba(0,0,0,0.5) 100%)' : 'linear-gradient(135deg, rgba(255,255,255,0.22) 0%, rgba(0,0,0,0.32) 100%)',
                  filter: isBody ? 'grayscale(0.75) brightness(0.75)' : 'none',
                  position: 'relative'
                }}>
                  {avatarUrl ? (
                    <img src={avatarUrl} alt={entity.nickname} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '14px', fontWeight: 700 }}>
                      {entity.nickname?.[0]?.toUpperCase() || '?'}
                    </div>
                  )}
                  {/* A dead character's icon stays on the scene instead of just
                      disappearing — a translucent red wash over the portrait marks
                      it as a body rather than a living occupant. */}
                  {isBody && (
                    <div style={{ position: 'absolute', inset: 0, background: 'rgba(180,0,40,0.4)', mixBlendMode: 'multiply' }} />
                  )}
                </div>

                {/* Crossed-out mark over the body's icon — a bold red X, same red
                    used everywhere else in the UI for "eliminated" state. */}
                {isBody && (
                  <svg viewBox="0 0 84 84" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 2 }}>
                    <line x1="14" y1="14" x2="70" y2="70" stroke="#ff2a5f" strokeWidth="7" strokeLinecap="round" style={{ filter: 'drop-shadow(0 0 4px rgba(255,42,95,0.8))' }} />
                    <line x1="70" y1="14" x2="14" y2="70" stroke="#ff2a5f" strokeWidth="7" strokeLinecap="round" style={{ filter: 'drop-shadow(0 0 4px rgba(255,42,95,0.8))' }} />
                  </svg>
                )}

                <div style={{
                  position: 'absolute',
                  bottom: '-10%',
                  left: '50%',
                  width: '43%',
                  height: '14%',
                  borderRadius: '50%',
                  transform: 'translateX(-50%)',
                  background: 'rgba(0,0,0,0.34)',
                  filter: 'blur(4px)'
                }} />

                {isBody && (
                  <span style={{
                    position: 'absolute',
                    bottom: '-31%',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    whiteSpace: 'nowrap',
                    fontSize: 'clamp(8px, 2.4vw, 10px)',
                    fontWeight: 800,
                    letterSpacing: '0.5px',
                    color: '#ff9caf',
                    textShadow: '0 0 6px rgba(255,42,95,0.6)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '3px'
                  }}>
                    <Icon name="skull" size={11} /> {entity.nickname}
                  </span>
                )}
              </div>
            </div>
          );
          });
        })()}
      </div>
    </div>
  );
}

function NeonButton({ children, onClick, variant = 'primary', type = 'button', style = {}, disabled = false }) {
  const handleMouseEnter = () => {
    if (disabled) return;
    playHoverSound(0.3);
  };

  const variants = {
    primary: {
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
      border: '1px solid #00f0ff',
      color: '#00f0ff',
      boxShadow: '0 0 10px rgba(0, 240, 255, 0.2)',
    },
    success: {
      background: 'linear-gradient(135deg, #0f2027 0%, #203a43 100%)',
      border: '1px solid #00ff87',
      color: '#00ff87',
      boxShadow: '0 0 10px rgba(0, 255, 135, 0.2)',
    },
    danger: {
      background: 'linear-gradient(135deg, #2c0b14 0%, #4a0e17 100%)',
      border: '1px solid #ff2a5f',
      color: '#ff2a5f',
      boxShadow: '0 0 10px rgba(255, 42, 95, 0.2)',
    },
    secondary: {
      background: 'rgba(255, 255, 255, 0.03)',
      border: '1px solid rgba(255, 255, 255, 0.15)',
      color: '#aaa',
      boxShadow: 'none',
    }
  };

  const currentVariant = variants[variant] || variants.primary;

  return (
    <button
      type={type}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      onMouseEnter={handleMouseEnter}
      onTouchStart={handleMouseEnter}
      style={{
        width: '100%',
        padding: '14px 20px',
        marginBottom: '14px',
        fontSize: '14px',
        fontWeight: '700',
        letterSpacing: '2px',
        textTransform: 'uppercase',
        borderRadius: '8px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        ...currentVariant,
        ...style
      }}
      onMouseOver={(e) => {
        if (disabled) return;
        e.currentTarget.style.transform = 'translateY(-2px)';
        e.currentTarget.style.boxShadow = currentVariant.border !== 'none'
          ? `0 0 20px ${currentVariant.border.split(' ')[2]}`
          : 'none';
        if(variant === 'secondary') e.currentTarget.style.color = '#fff';
      }}
      onMouseOut={(e) => {
        if (disabled) return;
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = currentVariant.boxShadow;
        if(variant === 'secondary') e.currentTarget.style.color = '#aaa';
      }}
      onMouseDown={(e) => { if (!disabled) e.currentTarget.style.transform = 'translateY(1px) scale(0.98)'; }}
    >
      {children}
    </button>
  );
}

// Looks up a character's portrait URL by name (used to render tiny avatar tokens
// for "you" on the map tile, and for other occupants found in a room).
function getCharacterUrl(name) {
  const found = CHARACTERS.find(c => c.name === name);
  return found ? found.url : null;
}

// --- MANSION MAP: an actual floor plan on CSS Grid + floor switcher + fog of war.
// Room name is ALWAYS visible to the player (it's just a floor plan) — what's fogged
// is the room's CONTENTS (who's there / what's happening): hidden behind a dense
// haze over the label, revealed only after a click, since the server sends that data
// privately to this player (see handleSelectRoom / 'room_entered'). One search per turn.
// Once a room is chosen, the player's own character token is drawn on that tile —
// visually "moving" their agent into the room — and the panel below the grid shows
// a small interior sketch, a flavor description, and who else was already there.
function MansionMap({ floor, onFloorChange, revealedRoom, roomChosen, onSelectRoom, myCharacter, spectatorMode, clearedRoomIds, myRole, isMobile, language }) {
  const layout = MANSION_LAYOUT[floor];
  const myAvatarUrl = getCharacterUrl(myCharacter);
  const isRestrictedRoom = (roomId) => roomId === 'f1_holding_cell';
  // Mark Room: green "already checked, no code here" highlight. Innocent-only
  // team knowledge (see 'room_marked_clean') — clearedRoomIds is simply never
  // populated for any other role, so this naturally renders as a no-op for them.
  const isClearedForTeam = (roomId) => myRole === 'Innocent' && Boolean(clearedRoomIds && clearedRoomIds[roomId]);

  return (
    <div
      style={{
        marginTop: '6px',
        marginBottom: '18px',
        opacity: roomChosen && !spectatorMode ? 0 : 1,
        transform: roomChosen && !spectatorMode ? 'scale(0.98)' : 'scale(1)',
        transition: 'opacity 0.4s cubic-bezier(0.4, 0, 0.2, 1), transform 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
        pointerEvents: roomChosen && !spectatorMode ? 'none' : 'auto'
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'center', gap: isMobile ? '6px' : '10px', marginBottom: '14px', flexWrap: 'wrap' }}>
        {[0, 1, 2].map((floorNum) => (
          <button
            key={floorNum}
            onClick={() => onFloorChange(floorNum)}
            onMouseEnter={() => { if (floor !== floorNum) playHoverSound(0.2); }}
            onTouchStart={() => { if (floor !== floorNum) playHoverSound(0.2); }}
            style={{
              padding: isMobile ? '10px 14px' : '8px 20px',
              minHeight: isMobile ? '40px' : 'auto',
              borderRadius: '6px',
              border: floor === floorNum ? '1px solid #00f0ff' : '1px solid rgba(255,255,255,0.15)',
              background: floor === floorNum ? 'rgba(0,240,255,0.1)' : 'rgba(255,255,255,0.03)',
              color: floor === floorNum ? '#00f0ff' : '#8a99ad',
              fontSize: '11px',
              fontWeight: 'bold',
              letterSpacing: '1px',
              cursor: 'pointer',
              transform: floor === floorNum ? 'translateY(-1px)' : 'translateY(0)',
              boxShadow: floor === floorNum ? '0 0 16px rgba(0,240,255,0.25)' : 'none',
              transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)'
            }}
          >
            {floorNum === 0 ? (language === 'ru' ? 'ПОДВАЛ' : language === 'uk' ? "ПІДВАЛ" : language === 'es' ? 'SÓTANO' : language === 'de' ? 'KELLER' : language === 'fr' ? 'SOUS-SOL' : 'BASEMENT') : (language === 'ru' ? `ЭТАЖ ${floorNum}` : language === 'uk' ? `ПОВЕРХ ${floorNum}` : language === 'es' ? `PLANTA ${floorNum}` : language === 'de' ? `ETAGE ${floorNum}` : language === 'fr' ? `ÉTAGE ${floorNum}` : `FLOOR ${floorNum}`)}
          </button>
        ))}
      </div>

      <div style={{
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: layout.columns,
        gridTemplateRows: layout.rows,
        gap: '3px',
        width: '100%',
        maxWidth: '600px',
        aspectRatio: '600 / 420',
        height: 'auto',
        margin: '0 auto',
        padding: isMobile ? '6px' : '10px',
        background: '#08080c',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '10px',
        boxSizing: 'border-box'
      }}>
        {/* Corridors/passages between rooms — purely visual strips, not clickable
            and not part of the fog of war (no one "hides" in them). */}
        {layout.corridors.map((corridor, idx) => (
          <div
            key={`corridor_${idx}`}
            style={{
              gridColumn: corridor.col,
              gridRow: corridor.row,
              background: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.025) 0px, rgba(255,255,255,0.025) 6px, transparent 6px, transparent 12px)',
              backgroundColor: 'rgba(255,255,255,0.015)',
              borderRadius: '2px'
            }}
          />
        ))}

        {layout.rooms.map((room) => {
          const isRevealed = revealedRoom && revealedRoom.roomId === room.id;
          const isDimmed = roomChosen && !isRevealed;
          const restricted = isRestrictedRoom(room.id);
          // A cleared room the player is CURRENTLY standing in should still read
          // as "revealed" (fresh green, avatar token, etc.) — the persistent
          // clear-tint below only kicks in once they've moved on.
          const isCleared = !isRevealed && isClearedForTeam(room.id);

          return (
            <div
              key={room.id}
              onClick={() => { if ((!roomChosen || spectatorMode) && (!restricted || spectatorMode)) onSelectRoom(room.id); }}
              style={{
                position: 'relative',
                gridColumn: room.col,
                gridRow: room.row,
                borderRadius: '4px',
                border: isRevealed ? '1px solid #00ff87' : isCleared ? '1px solid rgba(0,255,135,0.35)' : restricted ? '1px solid rgba(255,93,115,0.55)' : '1px solid rgba(255,255,255,0.2)',
                background: isRevealed ? 'rgba(0,255,135,0.08)' : isCleared ? 'rgba(0,255,135,0.05)' : restricted ? 'rgba(255,93,115,0.09)' : 'rgba(255,255,255,0.03)',
                overflow: 'hidden',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                textAlign: 'center',
                padding: '3px',
                boxSizing: 'border-box',
                cursor: (roomChosen && !spectatorMode) || (restricted && !spectatorMode) ? 'default' : 'pointer',
                opacity: isDimmed ? 0.35 : 1,
                transition: 'all 0.25s ease'
              }}
            >
              <span style={{
                fontSize: '9.5px',
                lineHeight: '1.25',
                letterSpacing: '0.3px',
                fontWeight: 'bold',
                position: 'relative',
                zIndex: 1,
                color: isRevealed ? '#00ff87' : isCleared ? '#5cffb0' : restricted ? '#ff8ea0' : '#bdc7db'
              }}>
                {translateRoomName(room.name, language).toUpperCase()}
              </span>

              {restricted && (
                <span style={{
                  position: 'absolute',
                  top: '4px',
                  right: '4px',
                  fontSize: '7px',
                  letterSpacing: '1px',
                  fontWeight: 'bold',
                  color: '#ff8ea0',
                  zIndex: 2,
                  textTransform: 'uppercase'
                }}>
                  {language === 'ru' ? 'Заперто' : language === 'uk' ? "Замкнено" : language === 'es' ? 'Cerrado' : language === 'de' ? 'Verschlossen' : language === 'fr' ? 'Verrouillé' : 'Locked'}
                </span>
              )}

              {isCleared && (
                <span style={{
                  position: 'absolute',
                  top: '4px',
                  right: '4px',
                  fontSize: '7px',
                  letterSpacing: '1px',
                  fontWeight: 'bold',
                  color: '#5cffb0',
                  zIndex: 2,
                  textTransform: 'uppercase'
                }}>
                  {language === 'ru' ? '✓ Проверено' : language === 'uk' ? "✓ Перевірено" : language === 'es' ? '✓ Revisado' : language === 'de' ? '✓ Geprüft' : language === 'fr' ? '✓ Disculpé' : '✓ Clear'}
                </span>
              )}

              {/* Fog of war: dense black haze over the label until the room is chosen.
                  Once the server confirms this room was selected, the haze clears.
                  Cleared rooms (Mark Room) get a much lighter haze instead of the
                  full black one, so the green "already checked" tint still reads
                  through it rather than getting smothered back to near-black. */}
              {!isRevealed && (
                <div style={{
                  position: 'absolute',
                  inset: 0,
                  background: isCleared
                    ? 'radial-gradient(circle, rgba(0,0,0,0.12) 0%, rgba(0,0,0,0.3) 100%)'
                    : 'radial-gradient(circle, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.88) 100%)'
                }} />
              )}

              {/* Your character token — appears on the tile you moved into, as if
                  your agent physically walked in. Small bounce-in animation. */}
              {isRevealed && myAvatarUrl && (
                <img
                  src={myAvatarUrl}
                  alt={myCharacter}
                  style={{
                    position: 'absolute',
                    bottom: '3px',
                    right: '3px',
                    width: '20px',
                    height: '20px',
                    borderRadius: '50%',
                    objectFit: 'cover',
                    border: '1.5px solid #00ff87',
                    boxShadow: '0 0 8px rgba(0,255,135,0.7)',
                    animation: 'tokenDropIn 0.4s ease-out',
                    zIndex: 2
                  }}
                />
              )}
            </div>
          );
        })}
      </div>

      {(!roomChosen || spectatorMode) && (
        <p style={{ textAlign: 'center', fontSize: '10px', color: '#6272a4', letterSpacing: '1px', marginTop: '12px' }}>
          {language === 'ru' ? 'ВЫБЕРИТЕ КОМНАТУ ДЛЯ ОБЫСКА — ОДНА ЗА ХОД' : language === 'uk' ? "ОБЕРІТЬ КІМНАТУ ДЛЯ ОБШУКУ — ОДНА ЗА ХІД" : language === 'es' ? 'ELIGE UNA SALA PARA REGISTRAR — UNA POR TURNO' : language === 'de' ? 'WÄHLE EINEN RAUM ZUM DURCHSUCHEN — EINER PRO ZUG' : language === 'fr' ? 'SÉLECTIONNEZ UNE PIÈCE À FOUILLER — UNE PAR TOUR' : 'SELECT A ROOM TO SEARCH — ONE PER TURN'}
        </p>
      )}
    </div>
  );
}

// --- JOKER EVIDENCE ROOM PICKER: a lightweight full-screen modal that lets
// the Joker drop a piece of evidence into ANY mansion room, independent of
// wherever they searched this turn (see 'plant_joker_evidence'). Reuses the
// same floor-plan grid/layout as MansionMap, but every tile is just a plain
// clickable target — no fog of war, no occupants, since the Joker isn't
// peeking into the room, only leaving something behind in it.
function JokerPlantRoomPicker({ floor, onFloorChange, onChooseRoom, submittingRoomId, onClose, language }) {
  const layout = MANSION_LAYOUT[floor];
  const isRestrictedRoom = (roomId) => roomId === 'f1_holding_cell';
  const isBusy = Boolean(submittingRoomId);

  return (
    <div
      onClick={() => { if (!isBusy) onClose(); }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2, 4, 10, 0.9)',
        backdropFilter: 'blur(16px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        zIndex: 40,
        animation: 'roomPeekIn 380ms cubic-bezier(0.16, 1, 0.3, 1)'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(680px, 100%)',
          maxHeight: '90vh',
          overflowY: 'auto',
          background: 'linear-gradient(145deg, rgba(13, 14, 24, 0.96) 0%, rgba(7, 8, 15, 0.98) 100%)',
          border: '1px solid rgba(224,64,251,0.25)',
          borderRadius: '22px',
          boxShadow: '0 28px 90px rgba(0, 0, 0, 0.5), 0 0 60px rgba(224,64,251,0.08)',
          padding: '22px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          animation: 'roomPeekIn 420ms cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
          <div>
            <p style={{ margin: '0 0 4px 0', fontSize: '11px', letterSpacing: '2px', color: '#e040fb' }}>{language === 'ru' ? 'ДЖОКЕР — ПОДБРОСИТЬ УЛИКУ' : language === 'uk' ? "ДЖОКЕР — ПІДКИНУТИ ДОКАЗ" : language === 'es' ? 'COMODÍN — PLANTAR PRUEBA' : language === 'de' ? 'JOKER — BEWEIS PLATZIEREN' : language === 'fr' ? 'JOKER — PLACER UNE PREUVE' : 'JOKER — PLANT EVIDENCE'}</p>
            <h3 style={{ margin: 0, fontSize: '20px', color: '#f0c6ff', letterSpacing: '1px' }}>{language === 'ru' ? 'ВЫБЕРИТЕ КОМНАТУ' : language === 'uk' ? "ОБЕРІТЬ КІМНАТУ" : language === 'es' ? 'ELIGE UNA SALA' : language === 'de' ? 'WÄHLE EINEN RAUM' : language === 'fr' ? 'CHOISISSEZ UNE PIÈCE' : 'CHOOSE A ROOM'}</h3>
          </div>
          <button
            onClick={onClose}
            disabled={isBusy}
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.15)',
              color: '#8a99ad',
              borderRadius: '8px',
              padding: '8px 14px',
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '1px',
              cursor: isBusy ? 'default' : 'pointer',
              opacity: isBusy ? 0.4 : 1,
              transition: 'all 0.2s ease'
            }}
          >
            {language === 'ru' ? 'ОТМЕНА' : language === 'uk' ? "СКАСУВАННЯ" : language === 'es' ? 'CANCELAR' : language === 'de' ? 'ABBRECHEN' : language === 'fr' ? 'ANNULER' : 'CANCEL'}
          </button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', gap: '10px' }}>
          {[0, 1, 2].map((floorNum) => (
            <button
              key={floorNum}
              onClick={() => { if (!isBusy) onFloorChange(floorNum); }}
              onMouseEnter={() => { if (floor !== floorNum && !isBusy) playHoverSound(0.2); }}
              onTouchStart={() => { if (floor !== floorNum && !isBusy) playHoverSound(0.2); }}
              style={{
                padding: '8px 20px',
                borderRadius: '6px',
                border: floor === floorNum ? '1px solid #e040fb' : '1px solid rgba(255,255,255,0.15)',
                background: floor === floorNum ? 'rgba(224,64,251,0.1)' : 'rgba(255,255,255,0.03)',
                color: floor === floorNum ? '#e040fb' : '#8a99ad',
                fontSize: '11px',
                fontWeight: 'bold',
                letterSpacing: '1px',
                cursor: isBusy ? 'default' : 'pointer',
                transform: floor === floorNum ? 'translateY(-1px)' : 'translateY(0)',
                boxShadow: floor === floorNum ? '0 0 16px rgba(224,64,251,0.25)' : 'none',
                transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)'
              }}
            >
              {floorNum === 0 ? (language === 'ru' ? 'ПОДВАЛ' : language === 'uk' ? "ПІДВАЛ" : language === 'es' ? 'SÓTANO' : language === 'de' ? 'KELLER' : language === 'fr' ? 'SOUS-SOL' : 'BASEMENT') : (language === 'ru' ? `ЭТАЖ ${floorNum}` : language === 'uk' ? `ПОВЕРХ ${floorNum}` : language === 'es' ? `PLANTA ${floorNum}` : language === 'de' ? `ETAGE ${floorNum}` : language === 'fr' ? `ÉTAGE ${floorNum}` : `FLOOR ${floorNum}`)}
            </button>
          ))}
        </div>

        <div style={{
          position: 'relative',
          display: 'grid',
          gridTemplateColumns: layout.columns,
          gridTemplateRows: layout.rows,
          gap: '3px',
          width: '100%',
          maxWidth: '600px',
          aspectRatio: '600 / 380',
          height: 'auto',
          margin: '0 auto',
          width: '100%',
          padding: '10px',
          background: '#08080c',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '10px',
          boxSizing: 'border-box'
        }}>
          {layout.corridors.map((corridor, idx) => (
            <div
              key={`plant_corridor_${idx}`}
              style={{
                gridColumn: corridor.col,
                gridRow: corridor.row,
                background: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.025) 0px, rgba(255,255,255,0.025) 6px, transparent 6px, transparent 12px)',
                backgroundColor: 'rgba(255,255,255,0.015)',
                borderRadius: '2px'
              }}
            />
          ))}

          {layout.rooms.map((room) => {
            const restricted = isRestrictedRoom(room.id);
            const isSubmittingThis = submittingRoomId === room.id;
            const isDisabled = restricted || isBusy;
            return (
              <div
                key={room.id}
                onClick={() => { if (!isDisabled) onChooseRoom(room.id); }}
                onMouseEnter={() => { if (!isDisabled) playHoverSound(0.12); }}
                onTouchStart={() => { if (!isDisabled) playHoverSound(0.12); }}
                style={{
                  position: 'relative',
                  gridColumn: room.col,
                  gridRow: room.row,
                  borderRadius: '4px',
                  border: restricted ? '1px solid rgba(255,93,115,0.3)' : isSubmittingThis ? '1px solid #e040fb' : '1px solid rgba(224,64,251,0.18)',
                  background: restricted ? 'rgba(255,93,115,0.06)' : isSubmittingThis ? 'rgba(224,64,251,0.16)' : 'rgba(224,64,251,0.04)',
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  textAlign: 'center',
                  padding: '4px',
                  cursor: isDisabled ? (restricted ? 'not-allowed' : 'default') : 'pointer',
                  opacity: restricted ? 0.35 : (isBusy && !isSubmittingThis ? 0.5 : 1),
                  transform: isSubmittingThis ? 'scale(0.96)' : 'scale(1)',
                  boxShadow: isSubmittingThis ? '0 0 18px rgba(224,64,251,0.35)' : 'none',
                  transition: 'all 0.22s cubic-bezier(0.4, 0, 0.2, 1)'
                }}
              >
                <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.4px', color: restricted ? '#ff5d73' : '#f0c6ff', lineHeight: 1.25 }}>
                  {isSubmittingThis ? (language === 'ru' ? 'ПОДБРАСЫВАЕМ…' : language === 'uk' ? "ПІДКИДАЄМО…" : language === 'es' ? 'PLANTANDO…' : language === 'de' ? 'PLATZIERE…' : language === 'fr' ? 'PLACEMENT…' : 'PLANTING…') : translateRoomName(room.name, language).toUpperCase()}
                </span>
              </div>
            );
          })}
        </div>

        <p style={{ margin: 0, fontSize: '11px', letterSpacing: '0.5px', color: '#6272a4', textAlign: 'center' }}>
          {language === 'ru' ? 'Выберите любую комнату на этом этаже, чтобы оставить там улику.' : language === 'uk' ? "Оберіть будь-яку кімнату на цьому поверсі, щоб залишити там доказ." : language === 'es' ? 'Elige cualquier sala de esta planta para dejar allí una prueba.' : language === 'de' ? 'Wähle einen beliebigen Raum auf dieser Etage, um dort einen Beweis zu hinterlassen.' : language === 'fr' ? 'Choisissez une pièce de cet étage pour y laisser une preuve.' : 'Pick any room on this floor to leave a piece of evidence behind.'}
        </p>
      </div>
    </div>
  );
}

// --- ACCOMPLICE: SET A TRAP ROOM PICKER — mirrors JokerPlantRoomPicker above
// almost exactly (same full-screen modal chrome, floor-plan grid, and "just a
// plain clickable target" tiles), but themed for the Accomplice and used to
// pin a trap to a chosen mansion room instead of leaving evidence behind (see
// 'set_trap'). Whoever walks into the trapped room loses all actions and
// abilities for their entire next round (see triggerTrapIfPresent /
// isPlayerTrapDebuffed server-side) — this modal only handles picking WHERE
// to put it.
function AccompliceTrapRoomPicker({ floor, onFloorChange, onChooseRoom, submittingRoomId, onClose, language }) {
  const layout = MANSION_LAYOUT[floor];
  const isRestrictedRoom = (roomId) => roomId === 'f1_holding_cell';
  const isBusy = Boolean(submittingRoomId);

  return (
    <div
      onClick={() => { if (!isBusy) onClose(); }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2, 4, 10, 0.9)',
        backdropFilter: 'blur(16px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        zIndex: 40,
        animation: 'roomPeekIn 380ms cubic-bezier(0.16, 1, 0.3, 1)'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(680px, 100%)',
          maxHeight: '90vh',
          overflowY: 'auto',
          background: 'linear-gradient(145deg, rgba(13, 14, 24, 0.96) 0%, rgba(7, 8, 15, 0.98) 100%)',
          border: '1px solid rgba(255,145,0,0.25)',
          borderRadius: '22px',
          boxShadow: '0 28px 90px rgba(0, 0, 0, 0.5), 0 0 60px rgba(255,145,0,0.08)',
          padding: '22px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          animation: 'roomPeekIn 420ms cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
          <div>
            <p style={{ margin: '0 0 4px 0', fontSize: '11px', letterSpacing: '2px', color: '#ff9100' }}>{language === 'ru' ? 'СООБЩНИК — УСТАНОВИТЬ ЛОВУШКУ' : language === 'uk' ? "СПІЛЬНИК — ВСТАНОВИТИ ПАСТКУ" : language === 'es' ? 'CÓMPLICE — INSTALAR TRAMPA' : language === 'de' ? 'KOMPLIZE — FALLE STELLEN' : language === 'fr' ? 'COMPLICE — POSER UN PIÈGE' : 'ACCOMPLICE — SET A TRAP'}</p>
            <h3 style={{ margin: 0, fontSize: '20px', color: '#ffd8a8', letterSpacing: '1px' }}>{language === 'ru' ? 'ВЫБЕРИТЕ КОМНАТУ' : language === 'uk' ? "ОБЕРІТЬ КІМНАТУ" : language === 'es' ? 'ELIGE UNA SALA' : language === 'de' ? 'WÄHLE EINEN RAUM' : language === 'fr' ? 'CHOISISSEZ UNE PIÈCE' : 'CHOOSE A ROOM'}</h3>
          </div>
          <button
            onClick={onClose}
            disabled={isBusy}
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.15)',
              color: '#8a99ad',
              borderRadius: '8px',
              padding: '8px 14px',
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '1px',
              cursor: isBusy ? 'default' : 'pointer',
              opacity: isBusy ? 0.4 : 1,
              transition: 'all 0.2s ease'
            }}
          >
            {language === 'ru' ? 'ОТМЕНА' : language === 'uk' ? "СКАСУВАННЯ" : language === 'es' ? 'CANCELAR' : language === 'de' ? 'ABBRECHEN' : language === 'fr' ? 'ANNULER' : 'CANCEL'}
          </button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', gap: '10px' }}>
          {[0, 1, 2].map((floorNum) => (
            <button
              key={floorNum}
              onClick={() => { if (!isBusy) onFloorChange(floorNum); }}
              onMouseEnter={() => { if (floor !== floorNum && !isBusy) playHoverSound(0.2); }}
              onTouchStart={() => { if (floor !== floorNum && !isBusy) playHoverSound(0.2); }}
              style={{
                padding: '8px 20px',
                borderRadius: '6px',
                border: floor === floorNum ? '1px solid #ff9100' : '1px solid rgba(255,255,255,0.15)',
                background: floor === floorNum ? 'rgba(255,145,0,0.1)' : 'rgba(255,255,255,0.03)',
                color: floor === floorNum ? '#ff9100' : '#8a99ad',
                fontSize: '11px',
                fontWeight: 'bold',
                letterSpacing: '1px',
                cursor: isBusy ? 'default' : 'pointer',
                transform: floor === floorNum ? 'translateY(-1px)' : 'translateY(0)',
                boxShadow: floor === floorNum ? '0 0 16px rgba(255,145,0,0.25)' : 'none',
                transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)'
              }}
            >
              {floorNum === 0 ? (language === 'ru' ? 'ПОДВАЛ' : language === 'uk' ? "ПІДВАЛ" : language === 'es' ? 'SÓTANO' : language === 'de' ? 'KELLER' : language === 'fr' ? 'SOUS-SOL' : 'BASEMENT') : (language === 'ru' ? `ЭТАЖ ${floorNum}` : language === 'uk' ? `ПОВЕРХ ${floorNum}` : language === 'es' ? `PLANTA ${floorNum}` : language === 'de' ? `ETAGE ${floorNum}` : language === 'fr' ? `ÉTAGE ${floorNum}` : `FLOOR ${floorNum}`)}
            </button>
          ))}
        </div>

        <div style={{
          position: 'relative',
          display: 'grid',
          gridTemplateColumns: layout.columns,
          gridTemplateRows: layout.rows,
          gap: '3px',
          width: '100%',
          maxWidth: '600px',
          aspectRatio: '600 / 380',
          height: 'auto',
          margin: '0 auto',
          width: '100%',
          padding: '10px',
          background: '#08080c',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '10px',
          boxSizing: 'border-box'
        }}>
          {layout.corridors.map((corridor, idx) => (
            <div
              key={`trap_corridor_${idx}`}
              style={{
                gridColumn: corridor.col,
                gridRow: corridor.row,
                background: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.025) 0px, rgba(255,255,255,0.025) 6px, transparent 6px, transparent 12px)',
                backgroundColor: 'rgba(255,255,255,0.015)',
                borderRadius: '2px'
              }}
            />
          ))}

          {layout.rooms.map((room) => {
            const restricted = isRestrictedRoom(room.id);
            const isSubmittingThis = submittingRoomId === room.id;
            const isDisabled = restricted || isBusy;
            return (
              <div
                key={room.id}
                onClick={() => { if (!isDisabled) onChooseRoom(room.id); }}
                onMouseEnter={() => { if (!isDisabled) playHoverSound(0.12); }}
                onTouchStart={() => { if (!isDisabled) playHoverSound(0.12); }}
                style={{
                  position: 'relative',
                  gridColumn: room.col,
                  gridRow: room.row,
                  borderRadius: '4px',
                  border: restricted ? '1px solid rgba(255,93,115,0.3)' : isSubmittingThis ? '1px solid #ff9100' : '1px solid rgba(255,145,0,0.18)',
                  background: restricted ? 'rgba(255,93,115,0.06)' : isSubmittingThis ? 'rgba(255,145,0,0.16)' : 'rgba(255,145,0,0.04)',
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  textAlign: 'center',
                  padding: '4px',
                  cursor: isDisabled ? (restricted ? 'not-allowed' : 'default') : 'pointer',
                  opacity: restricted ? 0.35 : (isBusy && !isSubmittingThis ? 0.5 : 1),
                  transform: isSubmittingThis ? 'scale(0.96)' : 'scale(1)',
                  boxShadow: isSubmittingThis ? '0 0 18px rgba(255,145,0,0.35)' : 'none',
                  transition: 'all 0.22s cubic-bezier(0.4, 0, 0.2, 1)'
                }}
              >
                <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.4px', color: restricted ? '#ff5d73' : '#ffd8a8', lineHeight: 1.25 }}>
                  {isSubmittingThis ? (language === 'ru' ? 'УСТАНАВЛИВАЕМ…' : language === 'uk' ? "ВСТАНОВЛЮЄМО…" : language === 'es' ? 'INSTALANDO…' : language === 'de' ? 'STELLE AUF…' : language === 'fr' ? 'POSE…' : 'SETTING…') : translateRoomName(room.name, language).toUpperCase()}
                </span>
              </div>
            );
          })}
        </div>

        <p style={{ margin: 0, fontSize: '11px', letterSpacing: '0.5px', color: '#6272a4', textAlign: 'center' }}>
          {language === 'ru' ? 'Выберите любую комнату на этом этаже, чтобы установить там ловушку.' : language === 'uk' ? "Оберіть будь-яку кімнату на цьому поверсі, щоб встановити там пастку." : language === 'es' ? 'Elige cualquier sala de esta planta para instalar allí una trampa.' : language === 'de' ? 'Wähle einen beliebigen Raum auf dieser Etage, um dort eine Falle aufzustellen.' : language === 'fr' ? 'Choisissez une pièce de cet étage pour y poser un piège.' : 'Pick any room on this floor to set a trap there.'}
        </p>
      </div>
    </div>
  );
}

// --- ACCOMPLICE: CHANGE EVIDENCE TARGET PICKER — a lightweight full-screen
// modal that lets the Accomplice pick which active player a piece of REAL
// room evidence gets fabricated to point at (see 'accomplice_change_evidence').
// Strictly excludes both eliminated/observing players AND the Accomplice
// themselves — framing yourself would be pointless, and the server rejects it
// too as a second line of defense. Reuses the same full-screen modal chrome
// as JokerPlantRoomPicker above, just with a simple player list instead of a
// room grid, since the target here is a person, not a location.
function AccompliceChangeEvidenceModal({ evidenceText, players, selfId, submittingTargetId, onChooseTarget, onClose, language }) {
  const isBusy = Boolean(submittingTargetId);
  const eligiblePlayers = (players || []).filter(p => p.id !== selfId && !p.isEliminated && !p.isObserver);

  return (
    <div
      onClick={() => { if (!isBusy) onClose(); }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2, 4, 10, 0.9)',
        backdropFilter: 'blur(16px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        zIndex: 40,
        animation: 'roomPeekIn 380ms cubic-bezier(0.16, 1, 0.3, 1)'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(460px, 100%)',
          maxHeight: '90vh',
          overflowY: 'auto',
          background: 'linear-gradient(145deg, rgba(13, 14, 24, 0.96) 0%, rgba(7, 8, 15, 0.98) 100%)',
          border: '1px solid rgba(255,145,0,0.25)',
          borderRadius: '22px',
          boxShadow: '0 28px 90px rgba(0, 0, 0, 0.5), 0 0 60px rgba(255,145,0,0.08)',
          padding: '22px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          animation: 'roomPeekIn 420ms cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
          <div>
            <p style={{ margin: '0 0 4px 0', fontSize: '11px', letterSpacing: '2px', color: '#ff9100' }}>{language === 'ru' ? 'СООБЩНИК — ИЗМЕНИТЬ УЛИКУ' : language === 'uk' ? "СПІЛЬНИК — ЗМІНИТИ ДОКАЗ" : language === 'es' ? 'CÓMPLICE — CAMBIAR PRUEBA' : language === 'de' ? 'KOMPLIZE — BEWEIS ÄNDERN' : language === 'fr' ? 'COMPLICE — MODIFIER UNE PREUVE' : 'ACCOMPLICE — CHANGE EVIDENCE'}</p>
            <h3 style={{ margin: 0, fontSize: '20px', color: '#ffd28e', letterSpacing: '1px' }}>{language === 'ru' ? 'КОГО ПОДСТАВИТЬ?' : language === 'uk' ? "КОГО ПІДСТАВИТИ?" : language === 'es' ? '¿A QUIÉN INCRIMINAR?' : language === 'de' ? 'WEN BELASTEN?' : language === 'fr' ? 'INCRIMINER QUI ?' : 'FRAME WHO?'}</h3>
          </div>
          <button
            onClick={onClose}
            disabled={isBusy}
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.15)',
              color: '#8a99ad',
              borderRadius: '8px',
              padding: '8px 14px',
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '1px',
              cursor: isBusy ? 'default' : 'pointer',
              opacity: isBusy ? 0.4 : 1,
              transition: 'all 0.2s ease'
            }}
          >
            {language === 'ru' ? 'ОТМЕНА' : language === 'uk' ? "СКАСУВАННЯ" : language === 'es' ? 'CANCELAR' : language === 'de' ? 'ABBRECHEN' : language === 'fr' ? 'ANNULER' : 'CANCEL'}
          </button>
        </div>

        <p style={{ margin: 0, fontSize: '12px', letterSpacing: '0.5px', color: '#bdc7db', lineHeight: 1.5 }}>
          {language === 'ru' ? 'Изменяется:' : language === 'uk' ? "Змінюється:" : language === 'es' ? 'Se está cambiando:' : language === 'de' ? 'Wird geändert:' : language === 'fr' ? 'Modification :' : 'Altering:'} <span style={{ color: '#f0c6ff' }}>{evidenceText || (language === 'ru' ? 'эта улика' : language === 'uk' ? "цей доказ" : language === 'es' ? 'esta prueba' : language === 'de' ? 'dieser Beweis' : language === 'fr' ? 'cette preuve' : 'this evidence')}</span>. {language === 'ru' ? 'Выберите, на кого она будет указывать — никто не узнает, что это сделали вы.' : language === 'uk' ? "Оберіть, на кого вона вказуватиме — ніхто не дізнається, що це зробили ви." : language === 'es' ? 'Elige a quién va a incriminar — nadie sabrá que fuiste tú quien lo hizo.' : language === 'de' ? 'Wähle, wen er belasten soll — niemand wird erfahren, dass du es warst.' : language === 'fr' ? "Choisissez qui cela doit impliquer — personne ne saura que c'est vous qui l'avez modifié." : "Pick who it should implicate — nobody will be told you're the one who changed it."}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '340px', overflowY: 'auto' }}>
          {eligiblePlayers.length === 0 ? (
            <p style={{ margin: '8px 0', color: '#6272a4', fontSize: '12px', textAlign: 'center' }}>{language === 'ru' ? 'Сейчас некого подставить.' : language === 'uk' ? "Зараз нема кого підставити." : language === 'es' ? 'Ahora mismo no hay a quién incriminar.' : language === 'de' ? 'Gerade gibt es niemanden, den du belasten kannst.' : language === 'fr' ? 'Aucun joueur éligible à incriminer pour le moment.' : 'No eligible players to frame right now.'}</p>
          ) : eligiblePlayers.map((p) => {
            const isSubmittingThis = submittingTargetId === p.id;
            const isDisabled = isBusy;
            return (
              <div
                key={p.id}
                onClick={() => { if (!isDisabled) onChooseTarget(p.id); }}
                onMouseEnter={() => { if (!isDisabled) playHoverSound(0.12); }}
                onTouchStart={() => { if (!isDisabled) playHoverSound(0.12); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 14px',
                  borderRadius: '10px',
                  border: isSubmittingThis ? '1px solid #ff9100' : '1px solid rgba(255,145,0,0.18)',
                  background: isSubmittingThis ? 'rgba(255,145,0,0.16)' : 'rgba(255,145,0,0.04)',
                  cursor: isDisabled ? 'default' : 'pointer',
                  opacity: isBusy && !isSubmittingThis ? 0.5 : 1,
                  transform: isSubmittingThis ? 'scale(0.98)' : 'scale(1)',
                  boxShadow: isSubmittingThis ? '0 0 18px rgba(255,145,0,0.35)' : 'none',
                  transition: 'all 0.22s cubic-bezier(0.4, 0, 0.2, 1)'
                }}
              >
                <span style={{ fontSize: '13px', fontWeight: 700, letterSpacing: '0.3px', color: '#ffd28e' }}>{p.nickname}</span>
                <span style={{ fontSize: '11px', letterSpacing: '1px', color: '#8a99ad' }}>{isSubmittingThis ? (language === 'ru' ? 'ПОДСТАВЛЯЕМ…' : language === 'uk' ? "ПІДСТАВЛЯЄМО…" : language === 'es' ? 'INCRIMINANDO…' : language === 'de' ? 'BELASTE…' : language === 'fr' ? 'INCRIMINATION…' : 'FRAMING…') : (language === 'ru' ? 'ВЫБРАТЬ' : language === 'uk' ? "ОБРАТИ" : language === 'es' ? 'ELEGIR' : language === 'de' ? 'AUSWÄHLEN' : language === 'fr' ? 'SÉLECTIONNER' : 'SELECT')}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// --- KILLER: POST-KILL DECISION MODAL — presented immediately after a kill
// lands (see handleKillPlayer / 'kill_options'). Deliberately NOT dismissible
// by clicking the backdrop or an escape key: this decision is mandatory, not
// optional UI chrome (if the Killer's turn ends without choosing, the server
// auto-resolves it as "expose" — see 'advanceTurn' server-side). "Escape via
// Vent" used to be offered here too, but that's dropped now — a Killer can
// already use the vent on their own via the normal "USE VENT" button, so a
// dedicated instant-escape option was redundant. Just two choices remain:
// hiding the body costs this turn's vent hop (stay put, no vent travel
// left), while leaving it exposed keeps the vent free to use afterward.
function KillDecisionModal({ targetNickname, resolving, onChoose, language }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(10, 0, 4, 0.92)',
        backdropFilter: 'blur(16px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        zIndex: 50,
        animation: 'roomPeekIn 380ms cubic-bezier(0.16, 1, 0.3, 1)'
      }}
    >
      <div
        style={{
          width: 'min(520px, 100%)',
          background: 'linear-gradient(145deg, rgba(24, 6, 10, 0.97) 0%, rgba(10, 3, 5, 0.98) 100%)',
          border: '1px solid rgba(255,42,95,0.35)',
          borderRadius: '22px',
          boxShadow: '0 28px 90px rgba(0, 0, 0, 0.55), 0 0 60px rgba(255,42,95,0.12)',
          padding: '26px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: '18px',
          animation: 'roomPeekIn 420ms cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <div>
          <p style={{ margin: '0 0 6px 0', fontSize: '11px', letterSpacing: '2px', color: '#ff2a5f' }}>{language === 'ru' ? 'ЦЕЛЬ УСТРАНЕНА' : language === 'uk' ? "ЦІЛЬ УСУНЕНО" : language === 'es' ? 'OBJETIVO ELIMINADO' : language === 'de' ? 'ZIEL AUSGESCHALTET' : language === 'fr' ? 'CIBLE ÉLIMINÉE' : 'TARGET ELIMINATED'}</p>
          <h3 style={{ margin: 0, fontSize: '24px', color: '#ff9caf', letterSpacing: '1px' }}>{(targetNickname || (language === 'ru' ? 'АГЕНТ' : language === 'uk' ? "АГЕНТ" : language === 'es' ? 'AGENTE' : language === 'de' ? 'AGENT' : language === 'fr' ? 'AGENT' : 'AGENT')).toUpperCase()} {language === 'ru' ? 'ПОВЕРЖЕН' : language === 'uk' ? "ПЕРЕМОЖЕНИЙ" : language === 'es' ? 'HA CAÍDO' : language === 'de' ? 'IST GEFALLEN' : language === 'fr' ? 'EST HORS-JEU' : 'IS DOWN'}</h3>
          <p style={{ margin: '10px 0 0 0', fontSize: '12px', lineHeight: 1.5, color: '#c9a3ab' }}>
            {language === 'ru' ? 'Что сделать с телом?' : language === 'uk' ? "Що зробити з тілом?" : language === 'es' ? '¿Qué hacer con el cuerpo?' : language === 'de' ? 'Was soll mit der Leiche geschehen?' : language === 'fr' ? 'Que faites-vous du corps ?' : 'What do you do with the body?'}
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <NeonButton variant="danger" style={{ margin: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }} disabled={resolving} onClick={() => onChoose('hide')}>
            <Icon name="hatch" size={15} /> {language === 'ru' ? 'СПРЯТАТЬ ТЕЛО' : language === 'uk' ? "СХОВАТИ ТІЛО" : language === 'es' ? 'OCULTAR CUERPO' : language === 'de' ? 'LEICHE VERSTECKEN' : language === 'fr' ? 'CACHER LE CORPS' : 'HIDE BODY'}
          </NeonButton>
          <NeonButton variant="primary" style={{ margin: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }} disabled={resolving} onClick={() => onChoose('expose')}>
            <Icon name="eye" size={15} /> {language === 'ru' ? 'ОСТАВИТЬ НА ВИДУ' : language === 'uk' ? "ЗАЛИШИТИ НА ВИДУ" : language === 'es' ? 'DEJAR A LA VISTA' : language === 'de' ? 'SICHTBAR LASSEN' : language === 'fr' ? 'LAISSER LE CORPS EXPOSÉ' : 'LEAVE BODY EXPOSED'}
          </NeonButton>
        </div>

        <p style={{ margin: 0, fontSize: '10px', letterSpacing: '0.5px', color: '#6272a4', textAlign: 'center' }}>
          {language === 'ru'
            ? 'Спрятанное тело найдут только целенаправленным поиском, но это использует прыжок через вентиляцию в этот ход. Оставленное на виду тело увидит следующий, кто зайдёт в комнату, а вентиляция останется доступной позже.'
            : language === 'uk' ? "Приховане тіло знайдуть лише цілеспрямованим пошуком, але це використає стрибок через вентиляцію в цьому ході. Залишене на видноті тіло побачить наступний, хто зайде в кімнату, а вентиляція залишиться доступною пізніше." : language === 'es' ? "Un cuerpo oculto solo se encuentra mediante una búsqueda explícita, pero te cuesta el salto de conducto de este turno. Dejarlo a la vista permite que el siguiente en entrar a la sala lo vea, y el conducto seguirá disponible después." : language === 'de' ? "Eine versteckte Leiche wird nur durch eine gezielte Suche gefunden, kostet dich aber den Lüftungsschacht-Sprung in diesem Zug. Lässt du sie sichtbar, sieht sie die nächste Person, die den Raum betritt, und der Lüftungsschacht bleibt danach weiterhin verfügbar." : language === 'fr' ? "Un corps caché n'est découvert que par une fouille explicite, mais cela vous coûte le saut de conduit de ce tour. Le laisser exposé garde le conduit libre pour plus tard." : "A hidden body is only ever found by an explicit search, but costs you this turn's vent hop. Leaving it exposed keeps the vent free to use afterward."}
        </p>
      </div>
    </div>
  );
}

// --- FORENSIC EXAMINER: VERIFY EVIDENCE RESULT — a small result popup for the
// Forensic Examiner's "Verify Evidence Authenticity" ability (see
// handleVerifyEvidence / 'verify_evidence' server-side). Deliberately simple
// compared to the modals above: this is a read-only report, not a decision —
// dismissible via backdrop click, close button, or Escape-equivalent (there's
// nothing pending to lose by closing it). Color/label flip between the two
// possible verdicts: AUTHENTIC (genuinely left by the Killer) in green, or
// FABRICATED/PLANTED (Joker plant or Accomplice frame job) in red.
function ForensicVerifyResultModal({ evidenceText, isAuthentic, onClose, language }) {
  const accent = isAuthentic ? '#00ff87' : '#ff2a5f';
  const accentSoft = isAuthentic ? 'rgba(0,255,135,0.35)' : 'rgba(255,42,95,0.35)';
  const accentGlow = isAuthentic ? 'rgba(0,255,135,0.12)' : 'rgba(255,42,95,0.12)';

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2, 4, 10, 0.9)',
        backdropFilter: 'blur(16px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        zIndex: 50,
        animation: 'roomPeekIn 380ms cubic-bezier(0.16, 1, 0.3, 1)'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(440px, 100%)',
          background: 'linear-gradient(145deg, rgba(13, 14, 24, 0.97) 0%, rgba(7, 8, 15, 0.98) 100%)',
          border: `1px solid ${accentSoft}`,
          borderRadius: '22px',
          boxShadow: `0 28px 90px rgba(0, 0, 0, 0.55), 0 0 60px ${accentGlow}`,
          padding: '26px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          animation: 'roomPeekIn 420ms cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <div>
          <p style={{ margin: '0 0 6px 0', fontSize: '11px', letterSpacing: '2px', color: '#8be7ff' }}>{language === 'ru' ? 'КРИМИНАЛИСТИЧЕСКИЙ АНАЛИЗ — ' : language === 'uk' ? "КРИМІНАЛІСТИЧНИЙ АНАЛІЗ — " : language === 'es' ? 'ANÁLISIS FORENSE — ' : language === 'de' ? 'FORENSISCHE ANALYSE — ' : language === 'fr' ? 'ANALYSE MÉDICO-LÉGALE — ' : 'FORENSIC ANALYSIS — '}{(evidenceText || (language === 'ru' ? 'УЛИКА' : language === 'uk' ? "ДОКАЗ" : language === 'es' ? 'PRUEBA' : language === 'de' ? 'BEWEIS' : language === 'fr' ? 'PREUVE' : 'EVIDENCE')).toUpperCase()}</p>
          <h3 style={{ margin: 0, fontSize: '24px', color: accent, letterSpacing: '1px' }}>
            {isAuthentic ? (language === 'ru' ? 'ПОДЛИННАЯ' : language === 'uk' ? "СПРАВЖНЯ" : language === 'es' ? 'AUTÉNTICA' : language === 'de' ? 'ECHT' : language === 'fr' ? 'AUTHENTIQUE' : 'AUTHENTIC') : (language === 'ru' ? 'СФАБРИКОВАНА / ПОДБРОШЕНА' : language === 'uk' ? "СФАБРИКОВАНА / ПІДКИНУТА" : language === 'es' ? 'FABRICADA / PLANTADA' : language === 'de' ? 'GEFÄLSCHT / PLATZIERT' : language === 'fr' ? 'FABRIQUÉE / PLACÉE' : 'FABRICATED / PLANTED')}
          </h3>
        </div>

        <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.55, color: '#bdc7db' }}>
          {isAuthentic
            ? (language === 'ru' ? 'Этот предмет действительно принадлежит убийце — он был оставлен на месте преступления, а не подстроен.' : language === 'uk' ? "Цей предмет справді належить убивці — він був залишений на місці злочину, а не підлаштований." : language === 'es' ? 'Este objeto realmente pertenece al asesino — fue dejado en la escena del crimen, no manipulado.' : language === 'de' ? 'Dieses Objekt gehört tatsächlich dem Mörder — es wurde am Tatort zurückgelassen, nicht manipuliert.' : language === 'fr' ? "Cet objet appartient réellement au tueur — il a été laissé sur les lieux, sans mise en scène." : 'This item genuinely belongs to the killer — it was left behind at the scene, not staged.')
            : (language === 'ru' ? 'Этот предмет не подлинный. Он был сфабрикован или подделан — подброшен, чтобы ввести в заблуждение того, кто его найдёт.' : language === 'uk' ? "Цей предмет несправжній. Він був сфабрикований або підроблений — підкинутий, щоб ввести в оману того, хто його знайде." : language === 'es' ? 'Este objeto no es auténtico. Fue fabricado o falsificado — plantado para engañar a quien lo encontrara.' : language === 'de' ? 'Dieses Objekt ist nicht echt. Es wurde gefälscht oder manipuliert — platziert, um jeden zu täuschen, der es findet.' : language === 'fr' ? "Cet objet n'est pas authentique. Il a été fabriqué ou altéré — placé pour tromper celui qui le trouverait." : 'This item is not authentic. It was fabricated or tampered with — planted to mislead whoever found it.')}
        </p>

        <button
          onClick={onClose}
          style={{
            alignSelf: 'flex-end',
            padding: '9px 18px',
            borderRadius: '8px',
            border: `1px solid ${accentSoft}`,
            background: accentGlow,
            color: accent,
            fontSize: '11px',
            fontWeight: 800,
            letterSpacing: '1px',
            cursor: 'pointer',
            transition: 'all 0.2s ease'
          }}
        >
          CLOSE
        </button>
      </div>
    </div>
  );
}

// --- TRAP TRIGGERED — a small warning popup shown to whichever player just
// walked into a mansion room holding an unsprung trap (see 'set_trap' /
// 'trap_triggered' server-side). Reuses the same simple, backdrop-dismissible
// modal chrome as ForensicVerifyResultModal above — this is a one-way notice,
// not a decision. The "next round" restriction it describes IS enforced
// server-side (see isPlayerTrapDebuffed / trap_debuff_status) — the actual
// lockout kicks in once the debuffed round starts, mirrored client-side via
// trapDebuffActive.
function TrapTriggeredModal({ roomName, onClose, language }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(10, 0, 4, 0.92)',
        backdropFilter: 'blur(16px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        zIndex: 50,
        animation: 'roomPeekIn 380ms cubic-bezier(0.16, 1, 0.3, 1)'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(440px, 100%)',
          background: 'linear-gradient(145deg, rgba(24, 6, 10, 0.97) 0%, rgba(10, 3, 5, 0.98) 100%)',
          border: '1px solid rgba(255,42,95,0.35)',
          borderRadius: '22px',
          boxShadow: '0 28px 90px rgba(0, 0, 0, 0.55), 0 0 60px rgba(255,42,95,0.12)',
          padding: '26px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          animation: 'roomPeekIn 420ms cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <div>
          <p style={{ margin: '0 0 6px 0', fontSize: '11px', letterSpacing: '2px', color: '#ff2a5f' }}>{language === 'ru' ? 'ЛОВУШКА СРАБОТАЛА' : language === 'uk' ? "ПАСТКА СПРАЦЮВАЛА" : language === 'es' ? 'TRAMPA ACTIVADA' : language === 'de' ? 'FALLE AUSGELÖST' : language === 'fr' ? 'PIÈGE DÉCLENCHÉ' : 'TRAP TRIGGERED'}</p>
          <h3 style={{ margin: 0, fontSize: '22px', color: '#ff9caf', letterSpacing: '1px' }}>
            {(translateRoomName(roomName, language) || (language === 'ru' ? 'ЭТА КОМНАТА' : language === 'uk' ? "ЦЯ КІМНАТА" : language === 'es' ? 'ESTA SALA' : language === 'de' ? 'DIESER RAUM' : language === 'fr' ? 'CETTE PIÈCE' : 'THIS ROOM')).toUpperCase()}
          </h3>
        </div>

        <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.55, color: '#bdc7db' }}>
          {language === 'ru'
            ? 'В этой комнате была спрятана ловушка. Весь ваш следующий раунд — и фазу действий, и суд — вы не сможете расследовать, искать тела или использовать способности.'
            : language === 'uk' ? "У цій кімнаті було приховано пастку. Увесь ваш наступний раунд — і фазу дій, і суд — ви не зможете розслідувати, шукати тіла чи використовувати здібності." : language === 'es' ? "En esta sala se había ocultado una trampa. Durante toda tu próxima ronda — tanto la fase de acciones como el juicio — no podrás investigar, buscar cuerpos ni usar ninguna habilidad." : language === 'de' ? "In diesem Raum war eine Falle versteckt. Während deiner gesamten nächsten Runde — sowohl in der Aktionsphase als auch beim Prozess — kannst du nicht durchsuchen, nach Leichen suchen oder Fähigkeiten einsetzen." : language === 'fr' ? "Un piège était caché dans cette pièce. Pendant tout votre prochain round — la phase de fouille comme le procès — vous ne pourrez ni enquêter, ni chercher de corps, ni utiliser aucune capacité." : "There was a trap hidden in this room. For all of your next round — both the search phase and the trial — you won't be able to investigate, search for bodies, or use any ability."}
        </p>

        <button
          onClick={onClose}
          style={{
            alignSelf: 'flex-end',
            padding: '9px 18px',
            borderRadius: '8px',
            border: '1px solid rgba(255,42,95,0.35)',
            background: 'rgba(255,42,95,0.12)',
            color: '#ff9caf',
            fontSize: '11px',
            fontWeight: 800,
            letterSpacing: '1px',
            cursor: 'pointer',
            transition: 'all 0.2s ease'
          }}
        >
          {language === 'ru' ? 'ЗАКРЫТЬ' : language === 'uk' ? "ЗАКРИТИ" : language === 'es' ? 'CERRAR' : language === 'de' ? 'SCHLIESSEN' : language === 'fr' ? 'FERMER' : 'CLOSE'}
        </button>
      </div>
    </div>
  );
}

function ForensicBodyExaminationModal({ clue, onClose, language }) {
  const getSentence = () => {
    if (!clue) return language === 'ru' ? 'Улика недоступна.' : language === 'uk' ? "Доказ недоступний." : language === 'es' ? 'Prueba no disponible.' : language === 'de' ? 'Beweis nicht verfügbar.' : language === 'fr' ? 'Aucun indice disponible.' : 'No clue available.';
    if (clue.type === 'bloodType') {
      return (
        <>
          {language === 'ru'
            ? <>Следы крови на месте преступления не совпадают с кровью жертвы — обнаружен тип <strong style={{ color: '#8be7ff' }}>{clue.value}</strong>.</>
            : language === 'uk'
            ? <>Сліди крові на місці злочину не збігаються з кров'ю жертви — виявлено тип <strong style={{ color: '#8be7ff' }}>{clue.value}</strong>.</>
            : language === 'es'
            ? <>Los rastros de sangre en la escena no coinciden con los de la víctima — se encontró el tipo <strong style={{ color: '#8be7ff' }}>{clue.value}</strong>.</>
            : language === 'de'
            ? <>Blutspuren am Tatort stimmen nicht mit denen des Opfers überein — Typ <strong style={{ color: '#8be7ff' }}>{clue.value}</strong> gefunden.</>
            : language === 'fr'
            ? <>Les traces de sang sur les lieux ne correspondent pas à celles de la victime — type <strong style={{ color: '#8be7ff' }}>{clue.value}</strong> détecté.</>
            : <>Blood traces at the scene don't match the victim's — type <strong style={{ color: '#8be7ff' }}>{clue.value}</strong> found.</>}
        </>
      );
    }
    if (clue.type === 'height') {
      if (clue.value === 'tall') {
        return language === 'ru'
          ? <>Угол раны указывает, что нападавший был <strong style={{ color: '#8be7ff' }}>выше</strong> жертвы.</>
          : language === 'uk'
          ? <>Кут рани вказує, що нападник був <strong style={{ color: '#8be7ff' }}>вищим</strong> за жертву.</>
          : language === 'es'
          ? <>El ángulo de la herida sugiere que el atacante era <strong style={{ color: '#8be7ff' }}>más alto</strong> que la víctima.</>
          : language === 'de'
          ? <>Der Wundwinkel deutet darauf hin, dass der Angreifer <strong style={{ color: '#8be7ff' }}>größer</strong> als das Opfer war.</>
          : language === 'fr'
          ? <>L'angle de la blessure suggère que l'agresseur était <strong style={{ color: '#8be7ff' }}>plus grand</strong> que la victime.</>
          : <>Wound angle suggests the attacker was <strong style={{ color: '#8be7ff' }}>taller</strong> than the victim.</>;
      }
      if (clue.value === 'short') {
        return language === 'ru'
          ? <>Угол раны указывает, что нападавший был <strong style={{ color: '#8be7ff' }}>ниже</strong> жертвы.</>
          : language === 'uk'
          ? <>Кут рани вказує, що нападник був <strong style={{ color: '#8be7ff' }}>нижчим</strong> за жертву.</>
          : language === 'es'
          ? <>El ángulo de la herida sugiere que el atacante era <strong style={{ color: '#8be7ff' }}>más bajo</strong> que la víctima.</>
          : language === 'de'
          ? <>Der Wundwinkel deutet darauf hin, dass der Angreifer <strong style={{ color: '#8be7ff' }}>kleiner</strong> als das Opfer war.</>
          : language === 'fr'
          ? <>L'angle de la blessure suggère que l'agresseur était <strong style={{ color: '#8be7ff' }}>plus petit</strong> que la victime.</>
          : <>Wound angle suggests the attacker was <strong style={{ color: '#8be7ff' }}>shorter</strong> than the victim.</>;
      }
      return language === 'ru'
        ? <>Угол раны не показывает заметной разницы — нападавший, вероятно, был <strong style={{ color: '#8be7ff' }}>среднего роста</strong>.</>
        : language === 'uk'
        ? <>Кут рани не показує помітної різниці — нападник, ймовірно, був <strong style={{ color: '#8be7ff' }}>середнього зросту</strong>.</>
        : language === 'es'
        ? <>El ángulo de la herida no muestra una diferencia notable — el atacante probablemente era de <strong style={{ color: '#8be7ff' }}>estatura media</strong>.</>
        : language === 'de'
        ? <>Der Wundwinkel zeigt keinen deutlichen Unterschied — der Angreifer war vermutlich von <strong style={{ color: '#8be7ff' }}>durchschnittlicher Größe</strong>.</>
        : language === 'fr'
        ? <>L'angle de la blessure ne montre pas de différence notable — l'agresseur était probablement de <strong style={{ color: '#8be7ff' }}>taille moyenne</strong>.</>
        : <>Wound angle shows no notable difference — the attacker was likely of <strong style={{ color: '#8be7ff' }}>average height</strong>.</>;
    }
    if (clue.value === 'heavy') {
      return language === 'ru'
        ? <>Характер повреждений указывает на <strong style={{ color: '#8be7ff' }}>значительную физическую силу</strong>.</>
        : language === 'uk'
        ? <>Характер пошкоджень вказує на <strong style={{ color: '#8be7ff' }}>значну фізичну силу</strong>.</>
        : language === 'es'
        ? <>La naturaleza de las heridas sugiere <strong style={{ color: '#8be7ff' }}>una fuerza física considerable</strong>.</>
        : language === 'de'
        ? <>Die Art der Verletzungen deutet auf <strong style={{ color: '#8be7ff' }}>erhebliche körperliche Kraft</strong> hin.</>
        : language === 'fr'
        ? <>La nature des blessures suggère <strong style={{ color: '#8be7ff' }}>une force physique considérable</strong>.</>
        : <>The nature of the injuries suggests <strong style={{ color: '#8be7ff' }}>significant physical strength</strong>.</>;
    }
    if (clue.value === 'light') {
      return language === 'ru'
        ? <>Характер повреждений указывает на <strong style={{ color: '#8be7ff' }}>умеренное, более лёгкое телосложение</strong>.</>
        : language === 'uk'
        ? <>Характер пошкоджень вказує на <strong style={{ color: '#8be7ff' }}>помірну, легшу статуру</strong>.</>
        : language === 'es'
        ? <>La naturaleza de las heridas sugiere <strong style={{ color: '#8be7ff' }}>una complexión moderada y más ligera</strong>.</>
        : language === 'de'
        ? <>Die Art der Verletzungen deutet auf einen <strong style={{ color: '#8be7ff' }}>mäßigen, leichteren Körperbau</strong> hin.</>
        : language === 'fr'
        ? <>La nature des blessures suggère <strong style={{ color: '#8be7ff' }}>une carrure modérée et plus légère</strong>.</>
        : <>The nature of the injuries suggests a <strong style={{ color: '#8be7ff' }}>moderate, lighter build</strong>.</>;
    }
    return language === 'ru'
      ? <>Характер повреждений не указывает на необычно сильного или лёгкого нападавшего — вероятно, <strong style={{ color: '#8be7ff' }}>среднее телосложение</strong>.</>
      : language === 'uk'
      ? <>Характер пошкоджень не вказує на незвично сильного чи легкого нападника — ймовірно, <strong style={{ color: '#8be7ff' }}>середня статура</strong>.</>
      : language === 'es'
      ? <>La naturaleza de las heridas no apunta a un atacante inusualmente fuerte o ligero — probablemente una <strong style={{ color: '#8be7ff' }}>complexión media</strong>.</>
      : language === 'de'
      ? <>Die Art der Verletzungen deutet nicht auf einen ungewöhnlich starken oder leichten Angreifer hin — wahrscheinlich ein <strong style={{ color: '#8be7ff' }}>durchschnittlicher Körperbau</strong>.</>
      : language === 'fr'
      ? <>La nature des blessures ne pointe pas vers un agresseur inhabituellement fort ou léger — probablement une <strong style={{ color: '#8be7ff' }}>carrure moyenne</strong>.</>
      : <>The nature of the injuries doesn't point to an unusually strong or light attacker — likely an <strong style={{ color: '#8be7ff' }}>average build</strong>.</>;
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(2, 4, 10, 0.9)', backdropFilter: 'blur(16px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', zIndex: 55,
        animation: 'roomPeekIn 380ms cubic-bezier(0.16, 1, 0.3, 1)'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(440px, 100%)',
          background: 'linear-gradient(145deg, rgba(13, 14, 24, 0.97) 0%, rgba(7, 8, 15, 0.98) 100%)',
          border: '1px solid rgba(0,240,255,0.3)', borderRadius: '22px',
          boxShadow: '0 28px 90px rgba(0,0,0,0.55), 0 0 60px rgba(0,240,255,0.1)',
          padding: '26px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '16px',
          animation: 'roomPeekIn 420ms cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <div>
          <p style={{ margin: '0 0 6px 0', fontSize: '11px', letterSpacing: '2px', color: '#8be7ff' }}>{language === 'ru' ? 'СУДЕБНО-МЕДИЦИНСКИЙ ОСМОТР ТЕЛА' : language === 'uk' ? "СУДОВО-МЕДИЧНИЙ ОГЛЯД ТІЛА" : language === 'es' ? 'EXAMEN FORENSE DEL CUERPO' : language === 'de' ? 'FORENSISCHE LEICHENUNTERSUCHUNG' : language === 'fr' ? 'EXAMEN MÉDICO-LÉGAL DU CORPS' : 'FORENSIC BODY EXAMINATION'}</p>
          <h3 style={{ margin: 0, fontSize: '22px', color: '#8be7ff', letterSpacing: '1px' }}>{language === 'ru' ? 'ОТЧЁТ ОСМОТРА' : language === 'uk' ? "ЗВІТ ОГЛЯДУ" : language === 'es' ? 'INFORME DE LA ESCENA' : language === 'de' ? 'TATORTBERICHT' : language === 'fr' ? 'RAPPORT DE SCÈNE' : 'SCENE REPORT'}</h3>
        </div>
        <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.7, color: '#bdc7db' }}>{getSentence()}</p>
        <button
          onClick={onClose}
          style={{
            alignSelf: 'flex-end', padding: '9px 18px', borderRadius: '8px', border: '1px solid rgba(0,240,255,0.3)',
            background: 'rgba(0,240,255,0.08)', color: '#8be7ff', fontSize: '11px', fontWeight: 800, letterSpacing: '1px', cursor: 'pointer'
          }}
        >
          {language === 'ru' ? 'ЗАКРЫТЬ' : language === 'uk' ? "ЗАКРИТИ" : language === 'es' ? 'CERRAR' : language === 'de' ? 'SCHLIESSEN' : language === 'fr' ? 'FERMER' : 'CLOSE'}
        </button>
      </div>
    </div>
  );
}


// username on top, character name in a smaller line right below it, and a
// green "VOTE" overlay that fades in on hover (click anywhere on the overlay
// to cast the vote). Its own component (not inline JSX) so each card can hold
function TrialPlayerRow({ player, playerCharacter, isEliminated, isConfirmed, isDraft, canVote, onVote, onCheck, index, showDetectiveAction, detectiveAvailable, detectiveTurnsRemaining, onDetectiveCheck, showOfficerAction, officerAvailable, officerTurnsRemaining, onOfficerLock, isSelf, language }) {
  return (
    <div style={{ padding: '10px', borderRadius: '8px', border: isEliminated ? '1px solid rgba(255,42,95,0.65)' : isDraft ? '1px solid #00ff87' : '1px solid rgba(0,240,255,0.3)', background: isEliminated ? 'rgba(255,42,95,0.11)' : isDraft ? 'rgba(0,255,135,0.08)' : '#0a0a0f', boxShadow: isEliminated ? '0 0 18px rgba(255,42,95,0.18)' : isDraft ? '0 0 18px rgba(0,255,135,0.2)' : 'none', transition: 'all 0.3s ease', opacity: 0, animation: `trialCardEnter 520ms cubic-bezier(0.16, 1, 0.3, 1) ${index * 70}ms forwards` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
        {playerCharacter?.url && <img src={playerCharacter.url} alt="" style={{ width: '42px', height: '42px', borderRadius: '7px', objectFit: 'cover' }} />}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: isEliminated ? '#ff8da6' : '#fff', textDecoration: isEliminated ? 'line-through' : 'none', transition: 'all 0.3s ease' }}>{player.nickname}</div>
          <div style={{ fontSize: '10px', color: isEliminated ? '#ff8da6' : '#8a99ad', marginTop: '2px' }}>{isEliminated ? (language === 'ru' ? 'УСТРАНЁН(А) — НАБЛЮДЕНИЕ' : language === 'uk' ? "УСУНЕНИЙ(А) — СПОСТЕРЕЖЕННЯ" : language === 'es' ? 'ELIMINADO(A) — ESPECTANDO' : language === 'de' ? 'AUSGESCHALTET — BEOBACHTER' : language === 'fr' ? 'ÉLIMINÉ — EN SPECTATEUR' : 'ELIMINATED — SPECTATING') : playerCharacter?.name || (language === 'ru' ? 'НЕИЗВЕСТНО' : language === 'uk' ? "НЕВІДОМО" : language === 'es' ? 'DESCONOCIDO' : language === 'de' ? 'UNBEKANNT' : language === 'fr' ? 'INCONNU' : 'UNKNOWN')}</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: '8px', marginTop: '9px' }}>
        <span style={{ padding: '7px 9px', borderRadius: '8px', border: `1px solid ${isEliminated ? 'rgba(255,42,95,0.45)' : isConfirmed ? 'rgba(0,255,135,0.45)' : 'rgba(255,255,255,0.12)'}`, background: isEliminated ? 'rgba(255,42,95,0.12)' : isConfirmed ? 'rgba(0,255,135,0.1)' : 'rgba(255,255,255,0.03)', color: isEliminated ? '#ff9caf' : isConfirmed ? '#76ffb4' : '#8a99ad', fontSize: '10px', fontWeight: 800, letterSpacing: '1px', transition: 'all 0.3s ease' }}>{isEliminated ? (language === 'ru' ? 'НАБЛЮДАТЕЛЬ' : language === 'uk' ? "СПОСТЕРІГАЧ" : language === 'es' ? 'ESPECTADOR' : language === 'de' ? 'BEOBACHTER' : language === 'fr' ? 'SPECTATEUR' : 'SPECTATOR') : isConfirmed ? (language === 'ru' ? 'ГОЛОС ОТДАН / ГОТОВ' : language === 'uk' ? "ГОЛОС ВІДДАНО / ГОТОВИЙ" : language === 'es' ? 'VOTO EMITIDO / LISTO' : language === 'de' ? 'STIMME ABGEGEBEN / BEREIT' : language === 'fr' ? 'VOTÉ / PRÊT' : 'VOTED / READY') : (language === 'ru' ? 'ОЖИДАНИЕ' : language === 'uk' ? "ОЧІКУВАННЯ" : language === 'es' ? 'ESPERANDO' : language === 'de' ? 'WARTEN' : language === 'fr' ? 'EN ATTENTE' : 'WAITING')}</span>
        <button onClick={onVote} disabled={!canVote} style={{ flex: 1, padding: '7px', borderRadius: '8px', border: isDraft ? '1px solid #00ff87' : '1px solid rgba(255,42,95,0.55)', background: isDraft ? 'rgba(0,255,135,0.16)' : 'rgba(255,42,95,0.12)', color: isDraft ? '#76ffb4' : '#ff9caf', fontWeight: 800, cursor: canVote ? 'pointer' : 'not-allowed', transition: 'all 0.25s ease-in-out' }}>{isDraft ? (language === 'ru' ? 'ВЫБРАНО' : language === 'uk' ? "ОБРАНО" : language === 'es' ? 'SELECCIONADO' : language === 'de' ? 'AUSGEWÄHLT' : language === 'fr' ? 'SÉLECTIONNÉ' : 'SELECTED') : (language === 'ru' ? 'ВЫБРАТЬ' : language === 'uk' ? "ОБРАТИ" : language === 'es' ? 'ELEGIR' : language === 'de' ? 'AUSWÄHLEN' : language === 'fr' ? 'SÉLECTIONNER' : 'SELECT')}</button>
        <button onClick={onCheck} style={{ padding: '7px', borderRadius: '8px', border: '1px solid rgba(0,240,255,0.4)', background: 'rgba(0,240,255,0.08)', color: '#8be7ff', fontWeight: 800, cursor: 'pointer', transition: 'all 0.25s ease-in-out' }}>{language === 'ru' ? 'ИНФО' : language === 'uk' ? "ІНФО" : language === 'es' ? 'INFO' : language === 'de' ? 'INFO' : language === 'fr' ? 'INFOS' : 'INFO'}</button>
      </div>
      {/* Detective-only special investigation action. Only ever rendered for
          the Detective themself (see showDetectiveAction), never for anyone
          else — the badge mirrors the Joker's "Ready" / "Cooldown: Xr" pattern. */}
      {showDetectiveAction && (
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
          <button
            onClick={onDetectiveCheck}
            disabled={!detectiveAvailable}
            style={{
              flex: 1,
              padding: '7px',
              borderRadius: '8px',
              border: detectiveAvailable ? '1px solid rgba(224,64,251,0.55)' : '1px solid rgba(255,255,255,0.12)',
              background: detectiveAvailable ? 'rgba(224,64,251,0.12)' : 'rgba(255,255,255,0.03)',
              color: detectiveAvailable ? '#e29bff' : '#6272a4',
              fontWeight: 800,
              fontSize: '11px',
              letterSpacing: '0.5px',
              cursor: detectiveAvailable ? 'pointer' : 'not-allowed',
              transition: 'all 0.25s ease-in-out'
            }}
          >
            🔍 {language === 'ru' ? 'ПРОВЕРИТЬ ЛОКАЦИЮ' : language === 'uk' ? "ПЕРЕВІРИТИ ЛОКАЦІЮ" : language === 'es' ? 'REVISAR UBICACIÓN' : language === 'de' ? 'STANDORT PRÜFEN' : language === 'fr' ? 'VÉRIFIER LA POSITION' : 'CHECK LOCATION'}
          </button>
          <span style={{
            padding: '7px 9px',
            borderRadius: '8px',
            border: `1px solid ${detectiveAvailable ? 'rgba(0,255,135,0.45)' : 'rgba(255,191,105,0.4)'}`,
            background: detectiveAvailable ? 'rgba(0,255,135,0.1)' : 'rgba(255,191,105,0.1)',
            color: detectiveAvailable ? '#76ffb4' : '#ffd28e',
            fontSize: '10px',
            fontWeight: 800,
            letterSpacing: '0.5px',
            whiteSpace: 'nowrap'
          }}>
            {detectiveAvailable ? (language === 'ru' ? 'ГОТОВО' : language === 'uk' ? "ГОТОВО" : language === 'es' ? 'LISTO' : language === 'de' ? 'BEREIT' : language === 'fr' ? 'PRÊT' : 'READY') : (language === 'ru' ? `ПЕРЕЗАРЯДКА: ${detectiveTurnsRemaining}` : language === 'uk' ? `ПЕРЕЗАРЯДКА: ${detectiveTurnsRemaining}` : language === 'es' ? `RECARGA: ${detectiveTurnsRemaining}` : language === 'de' ? `ABKLINGZEIT: ${detectiveTurnsRemaining}` : language === 'fr' ? `RECHARGE : ${detectiveTurnsRemaining}` : `COOLDOWN: ${detectiveTurnsRemaining}`)}
          </span>
        </div>
      )}
      {/* Officer-only special detainment action. Rendered for the Officer
          themself against ANY active suspect, including their own row
          (isSelf) — unlike the Detective, the Officer may lock themselves
          into the Holding Cell too. Same "Ready" / "Cooldown: Xr" badge
          pattern as the Detective's action above. */}
      {showOfficerAction && (
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
          <button
            onClick={onOfficerLock}
            disabled={!officerAvailable}
            style={{
              flex: 1,
              padding: '7px',
              borderRadius: '8px',
              border: officerAvailable ? '1px solid rgba(0,240,255,0.55)' : '1px solid rgba(255,255,255,0.12)',
              background: officerAvailable ? 'rgba(0,240,255,0.12)' : 'rgba(255,255,255,0.03)',
              color: officerAvailable ? '#8be7ff' : '#6272a4',
              fontWeight: 800,
              fontSize: '11px',
              letterSpacing: '0.5px',
              cursor: officerAvailable ? 'pointer' : 'not-allowed',
              transition: 'all 0.25s ease-in-out'
            }}
          >
            🔒 {isSelf ? (language === 'ru' ? 'ЗАПЕРЕТЬ СЕБЯ В КАМЕРЕ' : language === 'uk' ? "ЗАМКНУТИ СЕБЕ В КАМЕРІ" : language === 'es' ? 'ENCERRARME EN LA CELDA' : language === 'de' ? 'MICH IN DER ZELLE EINSPERREN' : language === 'fr' ? "M'ENFERMER DANS LA CELLULE" : 'LOCK MYSELF IN CELL') : (language === 'ru' ? 'ЗАПЕРЕТЬ В КАМЕРЕ' : language === 'uk' ? "ЗАМКНУТИ В КАМЕРІ" : language === 'es' ? 'ENCERRAR EN LA CELDA' : language === 'de' ? 'IN DER ZELLE EINSPERREN' : language === 'fr' ? 'ENFERMER DANS LA CELLULE' : 'LOCK IN CELL')}
          </button>
          <span style={{
            padding: '7px 9px',
            borderRadius: '8px',
            border: `1px solid ${officerAvailable ? 'rgba(0,255,135,0.45)' : 'rgba(255,191,105,0.4)'}`,
            background: officerAvailable ? 'rgba(0,255,135,0.1)' : 'rgba(255,191,105,0.1)',
            color: officerAvailable ? '#76ffb4' : '#ffd28e',
            fontSize: '10px',
            fontWeight: 800,
            letterSpacing: '0.5px',
            whiteSpace: 'nowrap'
          }}>
            {officerAvailable ? (language === 'ru' ? 'ГОТОВО' : language === 'uk' ? "ГОТОВО" : language === 'es' ? 'LISTO' : language === 'de' ? 'BEREIT' : language === 'fr' ? 'PRÊT' : 'READY') : (language === 'ru' ? `ПЕРЕЗАРЯДКА: ${officerTurnsRemaining}` : language === 'uk' ? `ПЕРЕЗАРЯДКА: ${officerTurnsRemaining}` : language === 'es' ? `RECARGA: ${officerTurnsRemaining}` : language === 'de' ? `ABKLINGZEIT: ${officerTurnsRemaining}` : language === 'fr' ? `RECHARGE : ${officerTurnsRemaining}` : `COOLDOWN: ${officerTurnsRemaining}`)}
          </span>
        </div>
      )}
    </div>
  );
}

function App() {
  // Lightweight viewport-width tracker — the app has no CSS media queries
  // anywhere (everything is inline styles), so any responsive behavior has
  // to be driven from JS. Currently only used to fix the trial phase modal
  // (see displayPhase === 'trial' below), whose two-column grid was hard-
  // coded to require ~660px+ of width and made the character dossier
  // unreadable on phone-sized screens.
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 720);
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 720);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Preload every character portrait, role sprite, and room backdrop as soon
  // as the app mounts, instead of letting the browser fetch each one lazily
  // the first time its <img> actually appears (role reveal, room move,
  // character dossier, etc). Same idea as the Dopamine Corner video: warm
  // the browser's own image cache up front so that when these images are
  // finally shown, they render instantly with no pop-in / blank flash.
  useEffect(() => {
    const urlsToPreload = [
      ...CHARACTERS.map((c) => c.url),
      ...Object.values(ROLES).map((r) => r.sprite),
      ...Object.values(ROOM_IMAGES)
    ];
    urlsToPreload.forEach((url) => {
      const img = new Image();
      img.src = url;
    });
  }, []);

  // Mobile browsers (Chrome in particular) size `100vh` and `position: fixed`
  // against the "layout viewport", which is taller than what's actually
  // visible whenever the address bar / bottom toolbar is on screen — so a
  // full-height card and any fixed bottom-anchored buttons render partly
  // (or fully) behind that browser chrome. window.visualViewport tracks the
  // *actually visible* area, so we mirror it into state and use it below to
  // (a) size the root container to real visible height instead of 100vh,
  // and (b) push every fixed bottom-anchored element up by however much the
  // browser UI (or the on-screen keyboard) is currently covering.
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window !== 'undefined' ? (window.visualViewport?.height || window.innerHeight) : 800
  );
  const [bottomInset, setBottomInset] = useState(0);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return;
    const vv = window.visualViewport;
    const updateViewportMetrics = () => {
      setViewportHeight(vv.height);
      setBottomInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    };
    updateViewportMetrics();
    vv.addEventListener('resize', updateViewportMetrics);
    vv.addEventListener('scroll', updateViewportMetrics);
    return () => {
      vv.removeEventListener('resize', updateViewportMetrics);
      vv.removeEventListener('scroll', updateViewportMetrics);
    };
  }, []);

  const [isConnected, setIsConnected] = useState(socket.connected);
  const [nickname, setNickname] = useState('');
  const [isNicknameSet, setIsNicknameSet] = useState(false);
  const [showMainContent, setShowMainContent] = useState(false);

  const [currentScreen, setCurrentScreen] = useState('main');
  const [isMusicPlaying, setIsMusicPlaying] = useState(true);
  const [audioInitialized, setAudioInitialized] = useState(false);
  const [volume, setVolume] = useState(0.4);
  const [dopamineCorner, setDopamineCorner] = useState(false);
  const [language, setLanguage] = useState('en');
  // Mirrors `language` for the socket listeners below, which are registered
  // once (empty dependency array) and would otherwise keep reading the
  // language value from the render they were set up in.
  const languageRef = useRef('en');
  useEffect(() => { languageRef.current = language; }, [language]);
  // Looks up a UI_TEXT key for the current language, falling back to English
  // for any key not yet translated for that language. Values can be plain
  // strings or functions (for strings that interpolate a variable, e.g. a
  // player count) — call-sites pass through any extra args in that case.
  const t = useCallback((key, ...args) => {
    const entry = (UI_TEXT[language] && UI_TEXT[language][key] !== undefined) ? UI_TEXT[language][key] : UI_TEXT.en[key];
    return typeof entry === 'function' ? entry(...args) : entry;
  }, [language]);
  const [dopamineCornerMinimized, setDopamineCornerMinimized] = useState(false);
  const dopamineCornerVideoRef = useRef(null);

  const [publicRooms, setPublicRooms] = useState([]);
  const [inputCode, setInputCode] = useState('');
  const [activeRoom, setActiveRoom] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');

  const [selectedChar, setSelectedChar] = useState(null);
  const [isReady, setIsReady] = useState(false);
  const [isCharacterMenuConfirmed, setIsCharacterMenuConfirmed] = useState(false);
  const [showSupportPopup, setShowSupportPopup] = useState(false);
  // Bug report / contact-email popup, opened from the SUPPORT button in Settings.
  const [showContactSupportPopup, setShowContactSupportPopup] = useState(false);
  const [supportEmailCopied, setSupportEmailCopied] = useState(false);
  const SUPPORT_EMAIL = 'limxelstudio@gmail.com';
  const copySupportEmail = useCallback(() => {
    navigator.clipboard?.writeText(SUPPORT_EMAIL).catch(() => {});
    setSupportEmailCopied(true);
    setTimeout(() => setSupportEmailCopied(false), 2000);
  }, []);

  // Countdown 5 -> 0 before the game starts (driven by the server)
  const [countdown, setCountdown] = useState(null);
  // Smooth fade to black after the countdown
  const [isGameStarting, setIsGameStarting] = useState(false);
  const [fadeOpacity, setFadeOpacity] = useState(0);

  // --- GAME SCREEN: intro text, skip vote, role ---
  const [gamePhase, setGamePhase] = useState('loading'); // loading -> intro -> role -> playing
  const [introTypedText, setIntroTypedText] = useState('');
  const [introFinished, setIntroFinished] = useState(false);
  const [introFadingOut, setIntroFadingOut] = useState(false);
  const [skipVotes, setSkipVotes] = useState({ count: 0, total: 0 });
  const [hasVotedSkip, setHasVotedSkip] = useState(false);
  const [myRole, setMyRole] = useState(null);
  const [roleRevealStage, setRoleRevealStage] = useState('hidden'); // hidden -> glow -> sprite -> label
  // Fade-out of the role reveal screen before the game itself starts (see ROLE_REVEAL_HOLD_MS)
  const [roleFadingOut, setRoleFadingOut] = useState(false);

  // --- GAMEPLAY: rounds, turn order, 30s timer (synced with the server) ---
  const [gameData, setGameData] = useState({ round: 0, turnOrder: [], phase: 'action' });
  const [currentTurnPlayerId, setCurrentTurnPlayerId] = useState(null);
  const [turnEndsAt, setTurnEndsAt] = useState(null);
  const [turnTimeLeft, setTurnTimeLeft] = useState(30);
  const [trialData, setTrialData] = useState(null);
  const [trialEndsAt, setTrialEndsAt] = useState(null);
  const [trialTimeLeft, setTrialTimeLeft] = useState(null);
  const [trialPlayers, setTrialPlayers] = useState([]);
  const [selectedTrialPlayer, setSelectedTrialPlayer] = useState(null);
  const [trialDraftTargetId, setTrialDraftTargetId] = useState(undefined);
  const [isTrialChatOpen, setIsTrialChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [draftChatMessage, setDraftChatMessage] = useState('');

  // --- SHARED CLUES BOARD: every piece of physical evidence (see
  // CHARACTER_EVIDENCE on the server) that ANY player has actually found via
  // 'investigate_room', synced to the whole room via 'clues_board_update'.
  // Deliberately separate from foundFragments above — the digital code digits
  // stay Innocent-only exactly as before, this board is everyone's shared case
  // file and never carries digit/code information. Persists across rounds
  // within a match (same lifetime as the server's plantedEvidence), and is
  // cleared on 'game_started' / lobby reset alongside the other match state.
  const [clues, setClues] = useState([]); // [{ id, text, roomId, roomName, plantedRound, foundBy: [{nickname, round}] }]
  const [isCluesOpen, setIsCluesOpen] = useState(false);
  // Which clue's "dossier" is currently expanded inside the panel — null means
  // the panel is showing the plain list. Cleared whenever the panel closes so
  // reopening it always starts back at the list.
  const [selectedClueId, setSelectedClueId] = useState(null);
  // --- FORENSIC EXAMINER: "Verify Evidence Authenticity" (see 'verify_evidence'
  // server-side). Gated to once every FORENSIC_VERIFY_COOLDOWN_TURNS of the
  // Forensic Examiner's OWN turns, same shape as the Joker/Accomplice
  // cooldowns above. forensicVerifyStatus mirrors jokerEvidenceStatus /
  // accompliceEvidenceStatus — refreshed by the server privately at the start
  // of every one of the Forensic Examiner's own turns (see
  // 'forensic_verify_status'), stays null for every other role.
  // forensicVerifyingId tracks which clue currently has a request in flight
  // (so its own "Verify" button can show a loading state); forensicVerifyResult
  // holds the last answer received, shown in a small result modal.
  const [forensicVerifyStatus, setForensicVerifyStatus] = useState(null); // { available, roundsRemaining } — shared cooldown is round-based, same as Detective/Officer/Mark Room
  const [forensicVerifyingId, setForensicVerifyingId] = useState(null);
  const [forensicVerifyResult, setForensicVerifyResult] = useState(null); // { evidenceId, text, isAuthentic } | null
  const [forensicBodyExamineResult, setForensicBodyExamineResult] = useState(null); // { bodyId, clue } | null
  // --- TRAP TRIGGERED (any role) -------------------------------------------
  // Set from the server's 'trap_triggered' event the instant this player
  // walks into a mansion room holding an unsprung trap (see 'set_trap' on the
  // Accomplice's side). Purely a notice — the actual "next round" restriction
  // it warns about is enforced server-side and mirrored here via
  // trapDebuffActive below.
  const [trapTriggeredInfo, setTrapTriggeredInfo] = useState(null); // { roomName } | null
  // Authoritative "am I currently locked out of actions/abilities this
  // round" flag — set from the server's private 'trap_debuff_status' event
  // (see triggerTrapIfPresent / isPlayerTrapDebuffed server-side), refreshed
  // at the start of both the action phase (round_start) and the Court/Trial
  // phase (trial_start), plus on reconnect (phase_state). Used to grey out
  // investigate/search/abilities client-side and to explain any
  // 'trap_debuff_blocked' rejection that slips through anyway.
  const [trapDebuffActive, setTrapDebuffActive] = useState(false);
  const [forensicReportUnlocked, setForensicReportUnlocked] = useState(false);
  // Non-null while this player is carrying Neurotoxin-7 (see the `neurotoxin`
  // field on 'investigate_result'), used purely for a small UI badge — the
  // server remains authoritative for every actual gameplay effect of the item.
  const [neurotoxinCarried, setNeurotoxinCarried] = useState(null); // { killsInCurrentRound } | null
  const [forensicSavedReport, setForensicSavedReport] = useState(null); // { bodyId, bodyNickname, roomName, type, value, savedAtRound }
  // --- BODIES TAB (Trial phase): mirrors the CLUES board above, but reads
  // from trialFindings.bodies (set once per trial via 'phase_state' /
  // buildFindingsSummary on the server) instead of a live socket feed — a
  // body's discovery is a one-time event surfaced right at TRIAL_ANNOUNCEMENT,
  // there's no equivalent of a mid-trial 'clues_board_update' to listen for.
  const [isBodiesOpen, setIsBodiesOpen] = useState(false);
  // Which body's detail view is currently expanded inside the panel — null
  // means the panel is showing the plain list. Cleared whenever the panel
  // closes so reopening it always starts back at the list.
  const [selectedBodyId, setSelectedBodyId] = useState(null);
  const [cinematic, setCinematic] = useState(null);
  const [phaseTransition, setPhaseTransition] = useState(0);
  // `gameData.phase` remains the server truth. `displayPhase` intentionally lags
  // during cinematic handoffs so the next layout cannot appear before blackout.
  const [displayPhase, setDisplayPhase] = useState('action');

  // --- MANSION MAP: currently displayed floor, the room revealed (out of fog) this
  // turn, and a flag for "search already used this turn". Reset on every new
  // onTurnStart, so the fog of war is always fresh at the start of a turn.
  const [mansionFloor, setMansionFloor] = useState(1);
  const [revealedRoom, setRevealedRoom] = useState(null);
  const [roomChosen, setRoomChosen] = useState(false);
  // Countdown shown after a room is inspected, purely visual — mirrors the
  // server's own shortened turn timer (see ROOM_INSPECT_MS on the server).
  const [autoEndSeconds, setAutoEndSeconds] = useState(null);
  // Killer only: whether 'use_vent' has already been used this turn. Purely a
  // UI convenience to grey out the button early — the server is the real
  // authority and rejects a second attempt regardless. Reset on every new
  // onTurnStart, same as roomChosen.
  const [ventUsedThisTurn, setVentUsedThisTurn] = useState(false);
  // Whether this turn's single room-interaction phase has already been spent
  // on EITHER "SEARCH FOR BODY" or "INVESTIGATE ROOM" — the two are mutually
  // exclusive, so once either fires both buttons grey out. Purely a UI
  // convenience, same caveat as ventUsedThisTurn: the server is the real
  // authority and rejects a second attempt regardless. Reset whenever a fresh
  // room is entered (onRoomEntered — covers both a new 'select_room' and a
  // mid-turn vent hop) or a new turn starts (onTurnStart).
  const [roomActionTaken, setRoomActionTaken] = useState(false);
  // Whether "INVESTIGATE ROOM" has actually been used on the room the player
  // is CURRENTLY standing in — required before "CHECK ROOM" becomes available
  // (see handleCheckRoom / server's 'check_room' gate). Reset on the exact
  // same triggers as roomActionTaken: a fresh room entered (onRoomEntered) or
  // a new turn starting (onTurnStart).
  const [investigateUsedThisTurn, setInvestigateUsedThisTurn] = useState(false);

  // --- EVIDENCE HUD (Innocent only): digits found via 'investigate_room' stay
  // visible for the rest of the match, keyed by their position in the code so
  // duplicates from re-investigating the same room don't pile up. NOT reset on
  // turn_start — unlike the fog-of-war state above, found evidence must persist
  // across every future turn/round.
  const [foundFragments, setFoundFragments] = useState([]); // [{ position, digit }]
  const [codeTotalDigits, setCodeTotalDigits] = useState(null);

  // --- MARK ROOM (Innocent only): rooms the Innocent team has personally
  // confirmed hold no code fragment (see 'room_marked_clean'), keyed by
  // roomId. Persists for the rest of the match just like foundFragments above
  // — a room's status never changes once cleared, so it's never reset on
  // turn_start, only wiped on a fresh match (see the room_joined reset below).
  const [clearedRoomIds, setClearedRoomIds] = useState({}); // { [roomId]: { roomName } }
  // Whether the Innocent's own "CHECK ROOM" ability (see 'check_room') is
  // currently off its 2-round cooldown — refreshed by the server privately at
  // the start of every one of the Innocent's own turns (see
  // 'mark_room_status'). Stays null for every other role, same treatment as
  // jokerEvidenceStatus below.
  const [markRoomStatus, setMarkRoomStatus] = useState(null); // { available, turnsRemaining }
  // True for the brief moment between clicking "CHECK ROOM" and the server's
  // 'check_room_result' coming back, purely to disable the button so a fast
  // double-click can't fire it twice while the first request is in flight.
  const [checkRoomSubmitting, setCheckRoomSubmitting] = useState(false);

  // --- JOKER EVIDENCE PLANTING (Joker only) --------------------------------
  // Whether 'plant_joker_evidence' is currently off cooldown, refreshed by the
  // server privately at the start of every one of the Joker's own turns (see
  // 'joker_evidence_status'). Stays null for every other role — the button
  // this drives is never even rendered for them.
  const [jokerEvidenceStatus, setJokerEvidenceStatus] = useState(null); // { available, turnsRemaining }
  // Whether the "PLANT EVIDENCE" room-picker modal (opened from the button
  // under the mansion map) is currently open, and which floor it's showing —
  // kept separate from mansionFloor so opening the picker never disturbs
  // whatever floor the player is browsing for their own room search.
  const [jokerPlantPickerOpen, setJokerPlantPickerOpen] = useState(false);
  const [jokerPlantFloor, setJokerPlantFloor] = useState(1);
  // True for the brief moment between clicking a room in the picker and the
  // server's 'joker_evidence_result' coming back — holds the roomId being
  // submitted so that exact tile can show a small loading state instead of
  // the whole modal looking unresponsive.
  const [jokerPlantSubmittingRoomId, setJokerPlantSubmittingRoomId] = useState(null);

  // --- ACCOMPLICE: "CHANGE EVIDENCE" (Accomplice only) ---------------------
  // Whether 'accomplice_change_evidence' is currently off cooldown, refreshed
  // by the server privately at the start of every one of the Accomplice's own
  // turns (see 'accomplice_evidence_status'). Stays null for every other
  // role — the evidence chips this drives are never even clickable for them.
  // Mirrors jokerEvidenceStatus above, just for this role's own ability.
  const [accompliceEvidenceStatus, setAccompliceEvidenceStatus] = useState(null); // { available, turnsRemaining }
  // Whether the "CHANGE EVIDENCE" target-picker modal is currently open, and
  // which piece of evidence (from revealedRoom.evidence) it's altering — set
  // by clicking a specific evidence chip directly (see canChangeThis /
  // handleOpenChangeEvidence). There's no standalone button for this.
  const [changeEvidencePickerOpen, setChangeEvidencePickerOpen] = useState(false);
  const [changeEvidenceTargetEvidenceId, setChangeEvidenceTargetEvidenceId] = useState(null);
  // True for the brief moment between picking a target player and the
  // server's 'accomplice_evidence_result' coming back — holds the playerId
  // being submitted so that exact row can show a small loading state instead
  // of the whole modal looking unresponsive. Same pattern as
  // jokerPlantSubmittingRoomId above.
  const [changeEvidenceSubmittingTargetId, setChangeEvidenceSubmittingTargetId] = useState(null);

  // --- ACCOMPLICE: "SET A TRAP" (Accomplice only) --------------------------
  // Mirrors the Joker's jokerPlantPickerOpen/jokerPlantFloor/
  // jokerPlantSubmittingRoomId trio above, just for 'set_trap' instead of
  // 'plant_joker_evidence'. Also mirrors jokerEvidenceStatus with its own
  // accompliceTrapStatus — refreshed by the server privately at the start of
  // every one of the Accomplice's own turns (see 'trap_status') — except this
  // one is a round-based cooldown (TRAP_COOLDOWN_ROUNDS) rather than an
  // own-turn-based one, so it carries `roundsRemaining` instead of
  // `turnsRemaining`.
  const [accompliceTrapStatus, setAccompliceTrapStatus] = useState(null); // { available, roundsRemaining }
  const [accompliceTrapPickerOpen, setAccompliceTrapPickerOpen] = useState(false);
  const [accompliceTrapFloor, setAccompliceTrapFloor] = useState(1);
  const [accompliceTrapSubmittingRoomId, setAccompliceTrapSubmittingRoomId] = useState(null);

  // --- DETECTIVE: "CHECK PLAYER'S LAST LOCATION" (Detective only, Court/Trial
  // phase only) ---------------------------------------------------------------
  // Whether 'detective_check_location' is currently off cooldown, refreshed by
  // the server privately at the start of every Court/Trial phase (see
  // 'detective_ability_status'). Stays null for every other role — the button
  // this drives is never even rendered for them.
  const [detectiveAbilityStatus, setDetectiveAbilityStatus] = useState(null); // { available, turnsRemaining }
  // Non-null result of this Detective's own 'detective_check_location' request
  // (see 'detective_check_result') — drives a small private popup that only
  // this Detective's own client ever renders. Nobody else, including the
  // checked player, ever sees this fire.
  const [detectiveCheckResult, setDetectiveCheckResult] = useState(null); // { targetNickname, roomName }

  // --- OFFICER: "LOCK IN HOLDING CELL" (Officer only, Court/Trial phase
  // only) -----------------------------------------------------------------
  // Whether 'officer_lock_player' is currently off cooldown, refreshed by the
  // server privately at the start of every Court/Trial phase (see
  // 'officer_ability_status'). Stays null for every other role — the button
  // this drives is never even rendered for them.
  const [officerAbilityStatus, setOfficerAbilityStatus] = useState(null); // { available, turnsRemaining }
  // Non-null right after this Officer's own 'officer_lock_player' request
  // succeeds (see 'officer_lock_result') — drives a small private confirmation
  // popup ("X will be locked in the Holding Cell next round") that only this
  // Officer's own client ever renders; nobody else, including the target,
  // learns the ability was used until the locked round actually starts.
  const [officerLockResult, setOfficerLockResult] = useState(null); // { targetNickname }
  // Public: whoever the server says is confined to the Holding Cell for the
  // CURRENT round (see 'round_start' / 'phase_state's lockedInHoldingCell).
  // Every player can see this, unlike officerLockResult above.
  const [lockedInHoldingCell, setLockedInHoldingCell] = useState(null); // { id, nickname }

  // --- KILLER: MURDER MECHANISM (Killer only) ------------------------------
  // Non-null the instant a kill has landed (see handleKillPlayer /
  // 'kill_options') but before the Killer has chosen what happens to the body
  // (see handleResolveKill / 'resolve_kill'). While set, the post-kill modal
  // is shown and every other turn action is locked out — mirrors the server's
  // own game.pendingKillDecision guard.
  // Shape: { targetId, targetNickname, roomId }
  const [pendingKillDecision, setPendingKillDecision] = useState(null);
  // True for the brief moment between picking a post-kill option and the
  // server's 'kill_resolved' coming back — disables the modal buttons so a
  // double-click can't fire two resolutions.
  const [resolvingKill, setResolvingKill] = useState(false);

  // --- OVERRIDE CODE TERMINAL (trial phase, Innocent only) & GAME OVER -----
  // Draft input for the code the player is about to submit via
  // 'submit_innocent_code'. Cleared on every submission (success or failure).
  const [codeGuess, setCodeGuess] = useState('');
  // True while the Killer has at least one victim nobody has found yet
  // anywhere in the mansion (see 'exit_status' / hasUndiscoveredBody on the
  // server). While true, the override terminal is physically unusable —
  // mirrors the server-side block in 'submit_innocent_code' so the button
  // is disabled up front instead of just failing after a submit attempt.
  const [exitSealed, setExitSealed] = useState(false);
  // Recap shown during the TRIAL_ANNOUNCEMENT cinematic — bodies and clues
  // that have actually been discovered so far (see 'findings' on
  // 'phase_state' / buildFindingsSummary on the server). Null outside that
  // window.
  const [trialFindings, setTrialFindings] = useState(null);
  // Non-null once the server declares the match over (see 'game_over'); drives
  // the GAME_OVER summary overlay. Cleared again on the next 'room_joined'
  // (the server resets the room and sends everyone back to the lobby).
  const [gameOverData, setGameOverData] = useState(null);

  // Toast queue used for the generic "useless trash" / "nothing of interest"
  // investigate results (and anything else that just needs an on-screen
  // notice). Persistent by design: a toast stays up until the player
  // dismisses it themselves via dismissToast (click) — no auto-timeout.
  const [toasts, setToasts] = useState([]);
  const toastIdRef = useRef(0);
  const pushToast = useCallback((message) => {
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev, { id, message, leaving: false }]);
  }, []);

  // Neurotoxin-7 pickup popup: shown once, centered, instead of a regular
  // toast, when 'investigate_result' comes back with `neurotoxin.outcome ===
  // 'picked_up'` (see onInvestigateResult). Auto-dismisses on its own, or on click.
  const [neurotoxinPopup, setNeurotoxinPopup] = useState(null); // { message } | null
  const neurotoxinPopupTimeoutRef = useRef(null);
  const showNeurotoxinPopup = useCallback((message) => {
    if (neurotoxinPopupTimeoutRef.current) clearTimeout(neurotoxinPopupTimeoutRef.current);
    setNeurotoxinPopup({ message });
    neurotoxinPopupTimeoutRef.current = setTimeout(() => {
      setNeurotoxinPopup(null);
    }, 3200);
  }, []);
  const dismissNeurotoxinPopup = useCallback(() => {
    if (neurotoxinPopupTimeoutRef.current) clearTimeout(neurotoxinPopupTimeoutRef.current);
    setNeurotoxinPopup(null);
  }, []);
  // Dismisses a toast on click — the only way a toast goes away. Plays the
  // exit animation first, then drops it from state once that's finished.
  const dismissToast = useCallback((id) => {
    setToasts(prev => prev.map(t => (t.id === id ? { ...t, leaving: true } : t)));
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 320);
  }, []);


  // ref so socket handlers always see the current character without re-running the hook
  const selectedCharRef = useRef(null);
  useEffect(() => {
    selectedCharRef.current = selectedChar;
  }, [selectedChar]);

  // refs for the typewriter, so it can be interrupted at any moment (skip)
  const typeIntervalRef = useRef(null);
  const introTextRef = useRef('');
  const introFinishedRef = useRef(false);
  useEffect(() => { introFinishedRef.current = introFinished; }, [introFinished]);

  // Real timestamp when the typewriter started (Date.now()). Typing progress is
  // computed from THIS, not from the number of setInterval ticks, so all players
  // finish typing at the same time even if a tab was backgrounded and throttled.
  const introStartTimeRef = useRef(null);

  // ref to the looping intro-typing sound (this one is reused — it's the only
  // track that must play continuously and stop on command)
  const typingLoopAudioRef = useRef(null);
  if (!typingLoopAudioRef.current) {
    const audio = new Audio();
    // This must be set before src. MediaElementAudioSourceNode outputs silence
    // for a cross-origin media element that was loaded without CORS permission.
    audio.crossOrigin = 'anonymous';
    audio.src = INTRO_TYPING_LOOP_SOUND;
    audio.loop = true;
    audio.volume = 0.35;
    audio.preload = 'auto';
    typingLoopAudioRef.current = audio;
  }

  // Each environment owns one loop. The shared fade routine below is the only
  // way tracks are switched, preventing abrupt cuts or overlapping ambience.
  const lobbyAudioRef = useRef(null);
  const explorationAudioRef = useRef(null);
  const trialAudioRef = useRef(null);
  const ambientAudioContextRef = useRef(null);
  const ambientGainNodesRef = useRef(new Map());
  const ambientGraphReadyRef = useRef(false);
  const ambientPauseTimersRef = useRef(new Map());
  // Authoritative client-side pointer to the track selected by the state
  // machine. It lets a later user gesture retry exactly that track after an
  // autoplay-policy rejection instead of guessing from stale UI state.
  const activeAmbientRef = useRef(null);
  const autoplayBlockedRef = useRef(false);
  const phaseSyncRef = useRef(null);
  // How far (ms) this client's own Date.now() is from the server's clock —
  // added to every local Date.now() call that gets compared against a
  // server-sent absolute endsAt/phaseStartTime timestamp. Without this, a
  // player whose system clock is off from real time sees every countdown
  // (turn, trial, etc.) run longer or shorter than it actually does on the
  // server, even though the server's own timers are perfectly accurate.
  // Measured via syncServerTime() below; starts at 0 (assume no skew) until
  // the first sync response arrives.
  const serverTimeOffsetRef = useRef(0);
  const now = useCallback(() => Date.now() + serverTimeOffsetRef.current, []);
  if (!lobbyAudioRef.current) {
    const audio = new Audio();
    audio.crossOrigin = 'anonymous';
    audio.src = BACKGROUND_MUSIC;
    audio.loop = true;
    audio.preload = 'auto';
    lobbyAudioRef.current = audio;
  }
  if (!explorationAudioRef.current) {
    const audio = new Audio();
    audio.crossOrigin = 'anonymous';
    audio.src = EXPLORATION_AMBIENT;
    audio.loop = true;
    audio.preload = 'auto';
    explorationAudioRef.current = audio;
  }
  if (!trialAudioRef.current) {
    const audio = new Audio();
    audio.crossOrigin = 'anonymous';
    audio.src = TRIAL_AMBIENT;
    audio.loop = true;
    audio.preload = 'auto';
    trialAudioRef.current = audio;
  }

  // Separate ref holding the room code that does NOT get reset when moving to the
  // game screen (unlike activeRoom/activeRoomRef, which are set to null there).
  // Needed by game_loaded / vote_skip_intro / request_role after that transition.
  const gameRoomCodeRef = useRef(null);

  // Ref to the local "auto-leave-room" visual countdown interval, so a fresh turn
  // (or an early manual end) can always clear whatever's currently running.
  const autoEndIntervalRef = useRef(null);
  const trackedTimeoutsRef = useRef([]);
  const trackedIntervalsRef = useRef([]);
  const skipIntroFlowRef = useRef(false);

  const trackTimeout = (id) => {
    trackedTimeoutsRef.current.push(id);
    return id;
  };

  const trackInterval = (id) => {
    trackedIntervalsRef.current.push(id);
    return id;
  };

  const clearTrackedTimers = () => {
    trackedTimeoutsRef.current.forEach((id) => clearTimeout(id));
    trackedIntervalsRef.current.forEach((id) => clearInterval(id));
    trackedTimeoutsRef.current = [];
    trackedIntervalsRef.current = [];
  };

  const clearAutoEndCountdown = () => {
    if (autoEndIntervalRef.current) {
      clearInterval(autoEndIntervalRef.current);
      autoEndIntervalRef.current = null;
    }
    setAutoEndSeconds(null);
  };

  useEffect(() => {
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.backgroundColor = '#0a0a0f';
    document.body.style.fontFamily = '"Courier New", Courier, monospace, sans-serif';
    // Allow the whole page to scroll (needed when the lobby content is taller than the screen)
    document.documentElement.style.height = '100%';
    document.body.style.height = '100%';
    document.body.style.overflowY = 'auto';
    document.body.style.overscrollBehavior = 'contain';

    const style = document.createElement('style');
    style.innerHTML = `
      html, body, #root { height: 100%; }
      button, input, textarea, select { font-family: inherit; transition: all 300ms ease-in-out; }
      button:not(:disabled):hover { filter: brightness(1.15); }
      input:focus, textarea:focus { outline: none; border-color: rgba(0, 240, 255, 0.8) !important; box-shadow: 0 0 0 3px rgba(0, 240, 255, 0.12); }
      ::-webkit-scrollbar { width: 6px; }
      ::-webkit-scrollbar-track { background: rgba(255,255,255,0.02); border-radius: 4px; }
      ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: #00f0ff; }

      .volume-slider {
        -webkit-appearance: none;
        width: 100%;
        height: 6px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 3px;
        outline: none;
        transition: all 0.2s;
      }
      .volume-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: #00f0ff;
        cursor: pointer;
        box-shadow: 0 0 8px #00f0ff;
        transition: transform 0.1s;
      }
      .volume-slider::-webkit-slider-thumb:hover {
        transform: scale(1.2);
      }
      .volume-slider::-moz-range-thumb {
        width: 16px;
        height: 16px;
        border: none;
        border-radius: 50%;
        background: #00f0ff;
        cursor: pointer;
        box-shadow: 0 0 8px #00f0ff;
        transition: transform 0.1s;
      }
      .volume-slider::-moz-range-thumb:hover {
        transform: scale(1.2);
      }
      .volume-slider::-moz-range-track {
        height: 6px;
        border-radius: 3px;
        background: rgba(255, 255, 255, 0.1);
      }
      .volume-slider::-moz-range-progress {
        height: 6px;
        border-radius: 3px;
        background: #00f0ff;
      }

      /* Horizontally swipeable row for the in-room action buttons on mobile —
         used when there are enough buttons (SEARCH FOR BODY / INVESTIGATE ROOM /
         CHECK ROOM / USE VENT / END TURN) that they can't all comfortably fit
         without scrolling. Scrollbar hidden cross-browser since the row itself
         (plus a bit of side padding) already signals it's scrollable. */
      .action-btn-scroll {
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
        -ms-overflow-style: none;
      }
      .action-btn-scroll::-webkit-scrollbar {
        display: none;
      }

      @keyframes supportIconPulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(0, 240, 255, 0.55), 0 8px 24px rgba(0,0,0,0.5); }
        50% { box-shadow: 0 0 0 10px rgba(0, 240, 255, 0), 0 8px 24px rgba(0,0,0,0.5); }
      }
      @keyframes countdownPulse {
        0% { transform: scale(0.7); opacity: 0; }
        30% { transform: scale(1.1); opacity: 1; }
        100% { transform: scale(1); opacity: 1; }
      }

      @keyframes introCaretBlink {
        0%, 49% { opacity: 1; }
        50%, 100% { opacity: 0; }
      }

      @keyframes roleGlowPulse {
        0% { opacity: 0; }
        100% { opacity: 1; }
      }

      @keyframes roleSpriteIn {
        0% { opacity: 0; transform: scale(0.85) translateY(12px); }
        100% { opacity: 1; transform: scale(1) translateY(0); }
      }

      @keyframes roleLabelIn {
        0% { opacity: 0; letter-spacing: 12px; }
        100% { opacity: 1; letter-spacing: 4px; }
      }

      @keyframes tokenDropIn {
        0% { opacity: 0; transform: translateY(-10px) scale(0.5); }
        100% { opacity: 1; transform: translateY(0) scale(1); }
      }

      @keyframes roomPeekIn {
        0% { opacity: 0; transform: scale(0.98); }
        100% { opacity: 1; transform: scale(1); }
      }

      @keyframes cinematicTextIn {
        0% { opacity: 0; transform: translateY(10px) scale(0.96); letter-spacing: 0.15em; }
        100% { opacity: 1; transform: translateY(0) scale(1); letter-spacing: 0.08em; }
      }

      @keyframes cinematicBlackout {
        0% { opacity: 0; }
        18%, 78% { opacity: 1; }
        100% { opacity: 0; }
      }

      @keyframes cinematicResolutionIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      @keyframes cinematicOverlayIn { from { opacity: 0; } to { opacity: 1; } }
      @keyframes cinematicOverlayOut { from { opacity: 1; } to { opacity: 0; } }
      @keyframes phaseCrossfade {
        0% { opacity: 0; backdrop-filter: blur(0px); }
        45% { opacity: 0.92; backdrop-filter: blur(6px); }
        100% { opacity: 0; backdrop-filter: blur(0px); }
      }
      @keyframes occupantEnter { from { opacity: 0; transform: translate(-50%, calc(-50% + 14px)) scale(0.72); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
      @keyframes trialCardEnter { from { opacity: 0; transform: translateY(18px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }
      @keyframes toastExit { from { opacity: 1; transform: translateY(0) scale(1); } to { opacity: 0; transform: translateY(10px) scale(0.94); } }
      @keyframes verdictEnter { from { opacity: 0; transform: translateY(22px) scale(0.92); } to { opacity: 1; transform: translateY(0) scale(1); } }
      @keyframes trialSkipPulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.045); } }
      @keyframes ambientGlowDrift {
        0%, 100% { opacity: 0.55; transform: scale(1); }
        50% { opacity: 0.85; transform: scale(1.06); }
      }
      @keyframes roomLightFlicker {
        0%, 100% { opacity: 0.85; }
        8% { opacity: 0.6; }
        14% { opacity: 0.92; }
        22% { opacity: 0.7; }
        30% { opacity: 0.88; }
        60% { opacity: 0.8; }
        75% { opacity: 0.95; }
        88% { opacity: 0.65; }
      }
      @keyframes roomDustDrift {
        0% { transform: translate(0, 0); opacity: 0; }
        10% { opacity: var(--dust-opacity, 0.5); }
        90% { opacity: var(--dust-opacity, 0.5); }
        100% { transform: translate(var(--dust-x, 14px), var(--dust-y, -26px)); opacity: 0; }
      }
      @keyframes roomVignettePulse {
        0%, 100% { opacity: 0.7; }
        50% { opacity: 0.9; }
      }
    `;
    document.head.appendChild(style);
  }, []);

  // This overlay is purely presentational: socket state is applied immediately,
  // while the visual handoff masks layout changes without delaying any events.
  useEffect(() => {
    if (currentScreen !== 'game' && gamePhase === 'loading') return undefined;
    setPhaseTransition(value => value + 1);
    return undefined;
  }, [currentScreen, gamePhase, displayPhase]);

  useEffect(() => {
    // The master volume from settings controls all sound in the game: background
    // music, countdown tick, role sound, typing sound, and button hover.
    masterVolume = volume;
    if (typingLoopAudioRef.current && !ambientGainNodesRef.current.has(typingLoopAudioRef.current)) {
      typingLoopAudioRef.current.volume = Math.max(0, Math.min(1, 0.35 * volume));
    }
  }, [volume]);

  // MediaElementAudioSourceNode + GainNode automation runs against the audio
  // clock, rather than requestAnimationFrame/setInterval, so an in-progress
  // crossfade is not dependent on a foreground tab's JavaScript timers.
  const getAmbientGainNode = (audio) => {
    if (!audio || typeof window === 'undefined') return null;
    // Safari/iOS requires both AudioContext creation and MediaElementSource
    // wiring to happen from a user gesture. Until initializeAudio() is called
    // by that gesture, fadeAudio intentionally falls back to audio.volume.
    if (!ambientGraphReadyRef.current) return null;
    if (!ambientAudioContextRef.current) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return null;
      ambientAudioContextRef.current = new AudioContextClass();
    }
    const context = ambientAudioContextRef.current;
    let gain = ambientGainNodesRef.current.get(audio);
    if (!gain) {
      const source = context.createMediaElementSource(audio);
      gain = context.createGain();
      gain.gain.value = audio.volume || 0;
      source.connect(gain).connect(context.destination);
      ambientGainNodesRef.current.set(audio, gain);
      audio.volume = 1;
    }
    if (context.state === 'suspended' && !document.hidden) context.resume().catch(() => {});
    return { context, gain };
  };

  const fadeAudio = (audio, targetVolume, duration = 900, pauseAtEnd = false) => {
    if (!audio) return;
    const node = getAmbientGainNode(audio);
    if (!node) {
      audio.volume = targetVolume;
      return;
    }
    const { context, gain } = node;
    const now = context.currentTime;
    const end = now + duration / 1000;
    // Holding the current scheduled value prevents a newly received phase
    // update from producing an audible jump halfway through a crossfade.
    if (typeof gain.gain.cancelAndHoldAtTime === 'function') gain.gain.cancelAndHoldAtTime(now);
    else {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
    }
    gain.gain.linearRampToValueAtTime(Math.max(0, Math.min(1, targetVolume)), end);
    // Do not pause silent ambience here: pausing would rely on a throttled
    // callback and can prevent its scheduled fade-in after a background tab.
  };

  const cancelScheduledPause = (audio) => {
    const timer = ambientPauseTimersRef.current.get(audio);
    if (timer) window.clearTimeout(timer);
    ambientPauseTimersRef.current.delete(audio);
  };

  const pauseAfterFade = (audio, duration) => {
    if (!audio) return;
    cancelScheduledPause(audio);
    const timer = window.setTimeout(() => {
      audio.pause();
      ambientPauseTimersRef.current.delete(audio);
    }, duration);
    ambientPauseTimersRef.current.set(audio, timer);
  };

  const targetMusicVolume = (audio) => (
    audio === typingLoopAudioRef.current ? volume * 0.35 : volume
  );

  const playAmbient = (audio, fadeDuration = 1100) => {
    if (!audioInitialized || !isMusicPlaying || !audio) return;
    cancelScheduledPause(audio);
    if (audio.paused) {
      const node = getAmbientGainNode(audio);
      if (node) node.gain.gain.setValueAtTime(0, node.context.currentTime);
      else audio.volume = 0;
    }
    audio.play()
      .then(() => { autoplayBlockedRef.current = false; })
      .catch(() => {
        autoplayBlockedRef.current = true;
        console.log('Ambient playback is awaiting a user interaction.');
      });
    fadeAudio(audio, targetMusicVolume(audio), fadeDuration);
  };

  const toggleMusic = () => {
    const nextEnabled = !isMusicPlaying;
    setIsMusicPlaying(nextEnabled);
    if (nextEnabled) initializeAudio(true);
    if (!nextEnabled) {
      fadeAudio(lobbyAudioRef.current, 0, 500, true);
      fadeAudio(explorationAudioRef.current, 0, 500, true);
      fadeAudio(trialAudioRef.current, 0, 500, true);
      fadeAudio(typingLoopAudioRef.current, 0, 500, true);
      [lobbyAudioRef.current, explorationAudioRef.current, trialAudioRef.current, typingLoopAudioRef.current]
        .forEach(audio => pauseAfterFade(audio, 500));
    }
  };

  const getActiveAmbient = () => {
    // Every pre-game screen (main menu, play_menu, connect_code, create_server,
    // settings, tutorial, servers_list, lobby, ...) shares the same lobby track.
    // Only 'game' has its own set of tracks driven by gamePhase/displayPhase —
    // this way navigating between menu buttons never interrupts the lobby music.
    if (currentScreen !== 'game') return lobbyAudioRef.current;
    if (gamePhase === 'intro') return typingLoopAudioRef.current;
    if (gamePhase !== 'playing') return null;
    return displayPhase === 'trial' ? trialAudioRef.current : explorationAudioRef.current;
  };

  // Browser autoplay is only unlocked by a real gesture. Prime every loop
  // at zero volume during that first gesture, so later server-driven phase shifts
  // can cross-fade without waiting for another click or focus event.
  const initializeAudio = (forceEnabled = false) => {
    if (audioInitialized || (!isMusicPlaying && !forceEnabled)) return;
    const activeAudio = getActiveAmbient();
    // This function is only reached from a click/tap/key gesture (or the music
    // toggle), so it is the one permitted place to construct the Web Audio graph.
    ambientGraphReadyRef.current = true;
    [lobbyAudioRef.current, explorationAudioRef.current, trialAudioRef.current, typingLoopAudioRef.current].forEach((audio) => {
      if (!audio) return;
      const node = getAmbientGainNode(audio);
      if (node) node.gain.gain.setValueAtTime(0, node.context.currentTime);
      else audio.volume = 0;
      audio.play().then(() => {
        if (audio !== activeAudio) audio.pause();
      }).catch(() => {});
    });
    setAudioInitialized(true);
  };

  useEffect(() => {
    const desiredAudio = getActiveAmbient();
    const allAudio = [lobbyAudioRef.current, explorationAudioRef.current, trialAudioRef.current, typingLoopAudioRef.current];
    if (!audioInitialized || !desiredAudio || !isMusicPlaying) {
      activeAmbientRef.current = null;
      if (audioInitialized) {
        allAudio.forEach(audio => fadeAudio(audio, 0, 700, true));
      } else {
        // Do not call fadeAudio before the first gesture: it must not create an
        // AudioContext or MediaElementSource during the initial render.
        allAudio.forEach(audio => { if (audio) audio.volume = 0; });
      }
      if (!isMusicPlaying) allAudio.forEach(audio => pauseAfterFade(audio, 700));
      return;
    }
    activeAmbientRef.current = desiredAudio;
    allAudio.filter(audio => audio !== desiredAudio).forEach(audio => fadeAudio(audio, 0, 1500, true));
    playAmbient(desiredAudio, 2000);
  }, [audioInitialized, currentScreen, gamePhase, displayPhase, isMusicPlaying]);

  // Lightweight, separate effect for live volume changes: just nudges the
  // gain of whichever track is currently playing, instead of re-running the
  // full ambient-switching effect above (which would otherwise re-fire on
  // every single slider tick — step="0.01" means many updates per second
  // while dragging — and caused the noticeable input lag).
  useEffect(() => {
    if (!audioInitialized || !isMusicPlaying) return;
    const audio = activeAmbientRef.current;
    if (!audio) return;
    const target = Math.max(0, Math.min(1, targetMusicVolume(audio)));
    const node = getAmbientGainNode(audio);
    if (node) {
      node.gain.gain.cancelScheduledValues(node.context.currentTime);
      node.gain.gain.setValueAtTime(target, node.context.currentTime);
    } else {
      audio.volume = target;
    }
  }, [volume]);

  useEffect(() => {
    const unlockAmbient = () => {
      if (!isMusicPlaying) return;
      if (!audioInitialized) {
        initializeAudio();
        return;
      }
      const activeAudio = activeAmbientRef.current || getActiveAmbient();
      if (activeAudio && (autoplayBlockedRef.current || activeAudio.paused)) {
        playAmbient(activeAudio, 250);
      }
    };
    window.addEventListener('pointerdown', unlockAmbient, { passive: true, capture: true });
    window.addEventListener('click', unlockAmbient, { capture: true });
    window.addEventListener('keydown', unlockAmbient, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', unlockAmbient, { capture: true });
      window.removeEventListener('click', unlockAmbient, { capture: true });
      window.removeEventListener('keydown', unlockAmbient, { capture: true });
    };
  }, [audioInitialized, currentScreen, gamePhase, displayPhase, isMusicPlaying]);

  useEffect(() => () => {
    [lobbyAudioRef.current, explorationAudioRef.current, trialAudioRef.current, typingLoopAudioRef.current].forEach(audio => audio?.pause());
  }, []);

  // Starts the fade-to-black + music fade-out. Once the fade finishes, switches the
  // screen to 'game' and tells the server the client has loaded.
  const startGameStartSequence = () => {
    setIsGameStarting(true);
    fadeAudio(lobbyAudioRef.current, 0, 3000, true);
    fadeAudio(explorationAudioRef.current, 0, 3000, true);
    fadeAudio(trialAudioRef.current, 0, 3000, true);
    fadeAudio(typingLoopAudioRef.current, 0, 3000, true);

    // Double requestAnimationFrame so the browser applies opacity:0 before the
    // CSS transition to opacity:1 starts (otherwise the transition won't play)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setFadeOpacity(1));
    });

    // After 3s (fade duration) the screen is fully black — switch the lobby to the
    // game screen. Both the fade overlay and the game screen are black, so the
    // transition is invisible to the player.
    trackTimeout(setTimeout(() => {
      setCurrentScreen('game');
      setGamePhase('loading');
      setActiveRoom(null);
      setPublicRooms([]);

      // Turn off the fade overlay itself. It sits at zIndex 9999 with
      // pointerEvents:'auto' and, if left on, would permanently cover the game
      // screen (zIndex 5) with solid black.
      setIsGameStarting(false);
      setFadeOpacity(0);

      // Use gameRoomCodeRef (not activeRoomRef) since it isn't reset above.
      if (gameRoomCodeRef.current) {
        socket.emit('game_loaded', { code: gameRoomCodeRef.current });
      }

      // Safety net in case the server never sends 'intro_start'. The server is
      // expected to assign roles and send 'intro_start' within LOAD_TIMEOUT_MS
      // (15s) of the first game_loaded, even if not everyone has loaded yet.
      //  1) at 8s, re-send 'game_loaded' in case the first packet was lost;
      //  2) at 20s (safely after the server's 15s) — if 'intro_start' still
      //     hasn't arrived, start the intro locally as a last resort.
      trackTimeout(setTimeout(() => {
        if (gamePhaseRef.current === 'loading' && gameRoomCodeRef.current) {
          console.log('WATCHDOG: intro_start not received yet — re-sending game_loaded as a nudge');
          socket.emit('game_loaded', { code: gameRoomCodeRef.current });
        }
      }, 8000));

      trackTimeout(setTimeout(() => {
        if (gamePhaseRef.current === 'loading') {
          console.log('WATCHDOG: intro_start still not received after 20s — starting intro locally as last-resort fallback');
          startIntroTypewriter();
        }
      }, 20000));
    }, 3100));
  };

  // ref to activeRoom, so timeouts/callbacks can read the current room code
  const activeRoomRef = useRef(null);
  useEffect(() => {
    activeRoomRef.current = activeRoom;
  }, [activeRoom]);

  // ref to the current game phase, so timeouts can read its current value
  const gamePhaseRef = useRef('loading');
  useEffect(() => {
    gamePhaseRef.current = gamePhase;
  }, [gamePhase]);

  // --- Intro text typewriter ---
  const startIntroTypewriter = () => {
    skipIntroFlowRef.current = false;
    introTextRef.current = '';
    setIntroTypedText('');
    setIntroFinished(false);
    setIntroFadingOut(false);
    setGamePhase('intro');

    if (typeIntervalRef.current) {
      clearInterval(typeIntervalRef.current);
      typeIntervalRef.current = null;
    }
    clearTrackedTimers();

    // Start the looping typing sound — plays until the text is fully typed
    try {
      const loop = typingLoopAudioRef.current;
      loop.currentTime = 0;
      if (isMusicPlaying) loop.play().catch(() => {});
    } catch (e) { /* noop */ }

    // Record the real start time. On every tick we compute how many characters
    // SHOULD be typed by now based on elapsed time, instead of just adding +1 char
    // per tick. This matters for background/inactive tabs: the browser may throttle
    // setInterval for seconds, but once it finally fires we immediately "catch up"
    // to the correct position instead of falling further behind other players.
    introStartTimeRef.current = Date.now();

    // Story text follows the current UI language (English/Russian for now,
    // falling back to English for the placeholder languages).
    const activeIntroStory = languageRef.current === 'ru' ? INTRO_STORY_RU : languageRef.current === 'uk' ? INTRO_STORY_UK : languageRef.current === 'es' ? INTRO_STORY_ES : languageRef.current === 'fr' ? INTRO_STORY_FR : INTRO_STORY;

    typeIntervalRef.current = trackInterval(setInterval(() => {
      const elapsed = Date.now() - introStartTimeRef.current;
      const targetLength = Math.min(activeIntroStory.length, Math.floor(elapsed / TYPING_MS_PER_CHAR));

      if (targetLength !== introTextRef.current.length) {
        introTextRef.current = activeIntroStory.slice(0, targetLength);
        setIntroTypedText(introTextRef.current);
      }

      if (targetLength >= activeIntroStory.length) {
        clearInterval(typeIntervalRef.current);
        typeIntervalRef.current = null;
        finishIntro();
      }
    }, 50));
  };

  const finishIntro = () => {
    if (skipIntroFlowRef.current || introFinishedRef.current) return;
    introFinishedRef.current = true;
    setIntroFinished(true);

    // Stop the looping typing sound — the text is fully typed
    try {
      const loop = typingLoopAudioRef.current;
      loop.pause();
      loop.currentTime = 0;
    } catch (e) { /* noop */ }
    // Brief pause to let the last line be read, then fade the text out
    trackTimeout(setTimeout(() => {
      setIntroFadingOut(true);
      trackTimeout(setTimeout(() => {
        if (skipIntroFlowRef.current) return;
        setGamePhase('role');
        revealRoleSequence();
      }, 900));
    }, 1400));
  };

  const resetIntroRoleUi = () => {
    clearTrackedTimers();
    if (typeIntervalRef.current) {
      clearInterval(typeIntervalRef.current);
      typeIntervalRef.current = null;
    }

    try {
      const loop = typingLoopAudioRef.current;
      loop.pause();
      loop.currentTime = 0;
    } catch (e) { /* noop */ }

    introFinishedRef.current = true;
    const activeIntroStory = languageRef.current === 'ru' ? INTRO_STORY_RU : languageRef.current === 'uk' ? INTRO_STORY_UK : languageRef.current === 'es' ? INTRO_STORY_ES : languageRef.current === 'fr' ? INTRO_STORY_FR : INTRO_STORY;
    introTextRef.current = activeIntroStory;
    setIntroTypedText(activeIntroStory);
    setIntroFinished(true);
    setIntroFadingOut(false);
    setRoleRevealStage('hidden');
    setRoleFadingOut(false);
    setGamePhase('playing');
  };

  const handleSkipVote = () => {
    if (hasVotedSkip || !gameRoomCodeRef.current) return;
    setHasVotedSkip(true);
    socket.emit('vote_skip_intro', { code: gameRoomCodeRef.current });
  };

  const selectTrialVote = (targetId) => {
    if (!trialData || trialData.status !== 'voting' || trialData.confirmedVoterIds?.includes(socket.id)) return;
    if (targetId === null) playSkipVoteSound(0.35);
    setTrialDraftTargetId(targetId);
  };

  const confirmTrialVote = () => {
    console.log('DEBUG confirmTrialVote', {
      code: gameRoomCodeRef.current,
      trialDraftTargetId,
      trialDataStatus: trialData?.status
    });
    if (!gameRoomCodeRef.current || trialDraftTargetId === undefined || trialData?.status !== 'voting') return;
    socket.emit('confirm_vote', { code: gameRoomCodeRef.current, targetId: trialDraftTargetId });
  };

  const unlockTrialVote = () => {
    if (!gameRoomCodeRef.current || !trialData?.confirmedVoterIds?.includes(socket.id) || trialData.status !== 'voting') return;
    socket.emit('unlock_vote', { code: gameRoomCodeRef.current });
  };

  const handleSendChatMessage = (e) => {
    e.preventDefault();
    if (displayPhase === 'trial' && (isEliminated || isObserver)) return;
    if (!gameRoomCodeRef.current || !draftChatMessage.trim()) return;
    socket.emit('send_chat_message', { code: gameRoomCodeRef.current, message: draftChatMessage.trim() });
    setDraftChatMessage('');
  };

  // Opens the shared CLUES panel and asks the server for a fresh snapshot —
  // covers the case where evidence was discovered while this panel was
  // closed and the toast/broadcast was missed (e.g. tab was backgrounded).
  // Always lands back on the list view, never a stale dossier from last time.
  const handleOpenClues = () => {
    setSelectedClueId(null);
    setIsCluesOpen(open => {
      const next = !open;
      if (next && gameRoomCodeRef.current) {
        socket.emit('get_clues_board', { code: gameRoomCodeRef.current });
      }
      return next;
    });
  };

  const handleCloseClues = () => {
    setIsCluesOpen(false);
    setSelectedClueId(null);
  };

  // Opens the BODIES panel. Unlike CLUES, there's nothing to re-fetch: the
  // findings recap (trialFindings) is already sitting in state, pushed once
  // by the server at TRIAL_ANNOUNCEMENT and stable for the rest of the trial.
  const handleOpenBodies = () => setIsBodiesOpen(open => !open);
  const handleCloseBodies = () => {
    setIsBodiesOpen(false);
    setSelectedBodyId(null);
  };

  const handleSelectClue = (clueId) => setSelectedClueId(clueId);
  const handleBackToCluesList = () => setSelectedClueId(null);

  // Forensic Examiner only: asks the server whether a specific, already-visible
  // piece of evidence on the CLUES/Evidence board is authentic (genuinely left
  // by the Killer) or fabricated/planted (see 'verify_evidence' server-side).
  // Gated client-side on the same cooldown flag the server keeps authoritative
  // (forensicVerifyStatus), purely for UX — the server has the final say and
  // simply won't answer if it disagrees.
  const handleVerifyEvidence = (evidenceId) => {
    if (myRole !== 'Forensic' || !gameRoomCodeRef.current || forensicVerifyingId) return;
    if (forensicVerifyStatus && forensicVerifyStatus.available === false) return;
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : language === 'uk' ? "Ви ще приходите до тями після пастки — у цьому раунді здібності недоступні." : language === 'es' ? 'Todavía te estás recuperando de la trampa — no hay habilidades disponibles esta ronda.' : language === 'de' ? 'Du erholst dich noch von der Falle — in dieser Runde stehen keine Fähigkeiten zur Verfügung.' : language === 'fr' ? "Vous vous remettez encore du piège — aucune capacité ce round." : "You're still recovering from the trap — no abilities this round."); return; }
    setForensicVerifyingId(evidenceId);
    playAbilityUseSound(0.75);
    socket.emit('verify_evidence', { code: gameRoomCodeRef.current, evidenceId });
  };

  const handleExamineBody = (bodyId) => {
    if (myRole !== 'Forensic' || !gameRoomCodeRef.current || !bodyId) return;
    if (forensicVerifyStatus && forensicVerifyStatus.available === false) return;
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : language === 'uk' ? "Ви ще приходите до тями після пастки — у цьому раунді здібності недоступні." : language === 'es' ? 'Todavía te estás recuperando de la trampa — no hay habilidades disponibles esta ronda.' : language === 'de' ? 'Du erholst dich noch von der Falle — in dieser Runde stehen keine Fähigkeiten zur Verfügung.' : language === 'fr' ? "Vous vous remettez encore du piège — aucune capacité ce round." : "You're still recovering from the trap — no abilities this round."); return; }
    playAbilityUseSound(0.75);
    socket.emit('examine_body', { code: gameRoomCodeRef.current, bodyId });
  };

  const handleViewForensicReport = (bodyId) => {
    if (myRole !== 'Forensic' || !gameRoomCodeRef.current || !bodyId) return;
    if (!forensicReportUnlocked) return;
    socket.emit('get_forensic_report', { code: gameRoomCodeRef.current, bodyId });
  };

  const handleCloseForensicResult = () => setForensicVerifyResult(null);
  const handleCloseForensicBodyResult = () => setForensicBodyExamineResult(null);

  const handleSelectBody = (bodyId) => setSelectedBodyId(bodyId);
  const handleBackToBodiesList = () => setSelectedBodyId(null);

  // ref to the current role, so timeouts below can read its current value
  const myRoleRef = useRef(null);
  useEffect(() => { myRoleRef.current = myRole; }, [myRole]);

  // Guards against the same tick firing twice (e.g. a socket effect briefly
  // double-subscribing due to React StrictMode in dev, or a duplicate server
  // event) — ignore a repeat of the same `remaining` value received almost
  // immediately after the first.
  const lastTickRef = useRef({ remaining: null, time: 0 });

  // --- Staged role reveal: edge glow -> sprite -> label ---
  const revealRoleSequence = () => {
    if (skipIntroFlowRef.current) return;
    setRoleRevealStage('glow');
    trackTimeout(setTimeout(() => {
      if (!skipIntroFlowRef.current) setRoleRevealStage('sprite');
    }, 500));
    trackTimeout(setTimeout(() => {
      if (!skipIntroFlowRef.current) setRoleRevealStage('label');
    }, 1300));

    // Play the role reveal sound (from the pre-warmed pool — no load delay or crackle)
    playRoleRevealSound(0.6);

    // Guard against a race: if 'role_assigned' never arrived (or arrived before
    // this client was ready to receive it), periodically ask the server to resend
    // it. Without this the screen would stay stuck since the whole reveal block
    // depends on activeRoleData being present.
    let attempts = 0;
    const retryInterval = trackInterval(setInterval(() => {
      attempts += 1;
      if (myRoleRef.current) {
        clearInterval(retryInterval);
        return;
      }
      if (gameRoomCodeRef.current) {
        console.log(`WATCHDOG: role_assigned not received yet — requesting role from server (attempt ${attempts})`);
        socket.emit('request_role', { code: gameRoomCodeRef.current });
      }
      if (attempts >= 5 || skipIntroFlowRef.current) {
        clearInterval(retryInterval);
      }
    }, 2000));
  };

  // --- Role reveal fade-out -> tell the server the game can start ---
  // Exactly ROLE_REVEAL_HOLD_MS (5s) after the label appears, fade out the reveal
  // block, and once the fade (ROLE_REVEAL_FADE_MS) finishes, emit 'role_reveal_done'.
  // The game starts for everyone once all players in the room have confirmed this
  // (see onGameStarted/onRoundStart below and role_reveal_done on the server).
  useEffect(() => {
    if (roleRevealStage !== 'label') return;

    const holdTimer = trackTimeout(setTimeout(() => {
      if (skipIntroFlowRef.current) return;
      setRoleFadingOut(true);

      const fadeTimer = trackTimeout(setTimeout(() => {
        if (!skipIntroFlowRef.current && gameRoomCodeRef.current) {
          socket.emit('role_reveal_done', { code: gameRoomCodeRef.current });
        }
      }, ROLE_REVEAL_FADE_MS));

      return () => clearTimeout(fadeTimer);
    }, ROLE_REVEAL_HOLD_MS));

    return () => clearTimeout(holdTimer);
  }, [roleRevealStage]);

  // --- Turn countdown: derive remaining time from the absolute turnEndsAt (from the
  // server) rather than decrementing per tick — so all players see the same time
  // even if a tab stutters for a second, and the server always decides when a turn
  // actually ends. ---
  useEffect(() => {
    if (!turnEndsAt) return;

    const tick = () => setTurnTimeLeft(Math.max(0, Math.ceil((turnEndsAt - now()) / 1000)));
    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [turnEndsAt]);

  // Measures the gap between this client's system clock and the server's by
  // round-tripping a 'time_sync' ping and halving the observed latency (a
  // standard NTP-style estimate — assumes the trip there and back take
  // roughly the same time). The result is stored in serverTimeOffsetRef and
  // used by every countdown below instead of raw Date.now(), so a player
  // whose device clock is wrong (bad timezone, unsynced clock, VPN, etc.)
  // still sees turn/trial timers that match what the server is actually
  // counting down, instead of running long or short by the size of the skew.
  const syncServerTime = useCallback(() => {
    const t0 = Date.now();
    socket.emit('time_sync');
    socket.once('time_sync_response', ({ serverTime }) => {
      const rtt = Date.now() - t0;
      serverTimeOffsetRef.current = serverTime + rtt / 2 - Date.now();
      console.log(`CLIENT time sync: offset=${serverTimeOffsetRef.current}ms, rtt=${rtt}ms`);
    });
  }, []);

  useEffect(() => {
    function onConnect() {
      console.log('CLIENT connected, socket.id =', socket.id);
      setIsConnected(true);

      // Calibrate against the server's clock as soon as we (re)connect — a
      // fresh connection is also the moment a stale offset from before a
      // reconnect would otherwise linger the longest.
      syncServerTime();

      // On socket reconnect (new socket.id) during the game screen, immediately
      // re-request our role — otherwise, if role_assigned was addressed to the old
      // socket.id, the new one would never receive it.
      if (gameRoomCodeRef.current && !myRoleRef.current) {
        socket.emit('request_role', { code: gameRoomCodeRef.current });
      }
      // A refresh/reconnect can miss a broadcast. Ask for the exact current
      // server micro-phase immediately instead of retaining a stale blackout.
      if (gameRoomCodeRef.current) {
        socket.emit('request_phase_state', { code: gameRoomCodeRef.current });
      }
    }
    function onDisconnect() {
      console.log('CLIENT disconnected');
      setIsConnected(false);
    }
    function onRoomsList(rooms) { setPublicRooms(rooms); }

    function onRoomJoined(roomData) {
      console.log('CLIENT room_joined:', roomData);
      setActiveRoom(roomData);
      setChatMessages(roomData.chatMessages || []);
      // Remember the room code in a ref that survives setActiveRoom(null)
      gameRoomCodeRef.current = roomData.roomCode;
      setCurrentScreen('lobby');
      setErrorMessage('');
      setSelectedChar(null);
      setIsReady(false);
      setIsCharacterMenuConfirmed(false);
      setCountdown(null);
      setIsGameStarting(false);
      setFadeOpacity(0);
      setGamePhase('loading');
      setIntroTypedText('');
      setIntroFinished(false);
      setIntroFadingOut(false);
      setSkipVotes({ count: 0, total: 0 });
      setHasVotedSkip(false);
      setMyRole(null);
      setRoleRevealStage('hidden');
      setRoleFadingOut(false);
      skipIntroFlowRef.current = false;
      setGameData({ round: 0, turnOrder: [], phase: 'action' });
      setCurrentTurnPlayerId(null);
      setTurnEndsAt(null);
      setTrialData(null);
      setTrialEndsAt(null);
      setTrialTimeLeft(null);
      setTrialPlayers([]);
      setDraftChatMessage('');
      setSelectedTrialPlayer(null);
      setTrialDraftTargetId(undefined);
      setIsTrialChatOpen(false);
      setMansionFloor(1);
      setRevealedRoom(null);
      setRoomChosen(false);
      clearAutoEndCountdown();
      setFoundFragments([]);
      setCodeTotalDigits(null);
      setClearedRoomIds({});
      setMarkRoomStatus(null);
      setCheckRoomSubmitting(false);
      setCodeGuess('');
      setExitSealed(false);
      setTrialFindings(null);
      setDetectiveAbilityStatus(null);
      setDetectiveCheckResult(null);
      setOfficerAbilityStatus(null);
      setOfficerLockResult(null);
      setLockedInHoldingCell(null);
      setTrapDebuffActive(false);
      setGameOverData(null);
      setToasts([]);
      setClues([]);
      setIsCluesOpen(false);
      setSelectedClueId(null);
      setForensicVerifyStatus(null);
      setForensicVerifyingId(null);
      setForensicVerifyResult(null);
      setForensicBodyExamineResult(null);
      setForensicSavedReport(null);
      setForensicReportUnlocked(false);
    }
    function onJoinError(msg) { setErrorMessage(msg); }

    function onRoomUpdated(updatedRoom) {
      console.log(
        'CLIENT received room_updated. my socket.id =', socket.id,
        'status =', updatedRoom.status,
        'host =', updatedRoom.hostId,
        'players =',
        updatedRoom.players.map(p => ({ id: p.id, nick: p.nickname, char: p.character, ready: p.isReady }))
      );

      setActiveRoom({
        roomId: updatedRoom.id,
        roomCode: updatedRoom.code,
        roomName: updatedRoom.name,
        type: updatedRoom.type,
        hostId: updatedRoom.hostId,
        status: updatedRoom.status,
        players: updatedRoom.players
      });
      setChatMessages(updatedRoom.chatMessages || []);
      // Keep the ref in sync on every room update
      gameRoomCodeRef.current = updatedRoom.code;

      const myData = updatedRoom.players.find(p => p.id === socket.id);
      if (myData) {
        setIsReady(myData.isReady);
        setIsCharacterMenuConfirmed(myData.isReady);

        if (!selectedCharRef.current && myData.character) {
          setSelectedChar(myData.character);
        }
      } else {
        console.log('CLIENT WARNING: my socket.id not found in updatedRoom.players — possible stale socket.id after reconnect');
      }
    }

    // Server started the countdown (all players ready)
    function onCountdownTick({ remaining }) {
      // A tick at remaining <= 0 is never shown: 'game_start' follows almost
      // immediately and resets countdown, and React batches both updates into one
      // render, so "0" never appears on screen. Ignore it here too, so we don't
      // play an "extra" tick sound with nothing shown on screen — the last
      // visible/audible step is remaining === 1, then game_start.
      if (remaining <= 0) return;

      const now = Date.now();
      if (lastTickRef.current.remaining === remaining && now - lastTickRef.current.time < 400) {
        console.log('CLIENT ignoring duplicate countdown tick:', remaining);
        return;
      }
      lastTickRef.current = { remaining, time: now };

      console.log('CLIENT countdown tick:', remaining);
      setCountdown(remaining);
      playCountdownTick(0.5);
    }

    // Someone cancelled ready / left — countdown interrupted
    function onCountdownCancel() {
      console.log('CLIENT countdown cancelled');
      setCountdown(null);
    }

    // Countdown reached 0 — start the fade-out and music fade
    function onGameStart() {
      console.log('CLIENT game_start received');
      setCountdown(null);
      startGameStartSequence();
    }

    // Server signals everyone has loaded into the game — start the intro for all at once
    function onIntroStart() {
      console.log('CLIENT intro_start received');
      startIntroTypewriter();
    }

    // Update to the skip-intro vote counter
    function onSkipIntroUpdate({ count, total }) {
      setSkipVotes({ count, total });
    }

    // Everyone voted to skip — force-finish typing the text
    function onIntroSkip() {
      if (typeIntervalRef.current) {
        clearInterval(typeIntervalRef.current);
        typeIntervalRef.current = null;
      }
      const activeIntroStory = languageRef.current === 'ru' ? INTRO_STORY_RU : languageRef.current === 'uk' ? INTRO_STORY_UK : languageRef.current === 'es' ? INTRO_STORY_ES : languageRef.current === 'fr' ? INTRO_STORY_FR : INTRO_STORY;
      introTextRef.current = activeIntroStory;
      setIntroTypedText(activeIntroStory);
      finishIntro();
    }

    // Server assigned this player's role (randomly, one each, except Innocent)
    function onRoleAssigned({ role }) {
      console.log('CLIENT role_assigned:', role);
      setMyRole(role);
    }

    // Server confirmed the game itself has started (after everyone finished the role reveal)
    function onGameStarted() {
      console.log('CLIENT game_started received');
      setGamePhase('playing');
      if (gameRoomCodeRef.current) socket.emit('request_phase_state', { code: gameRoomCodeRef.current });
    }

    // A new round started: server sent a freshly shuffled turn order
    function onRoundStart({ round, turnOrder, lockedInHoldingCell: roundLock }) {
      console.log('CLIENT round_start:', round, turnOrder);
      setGameData({ round, turnOrder, phase: 'action' });
      // Public: someone the Officer locked in a previous trial is confined to
      // the Holding Cell for this whole round — surface it to everyone the
      // instant the round starts, same as any other round-level state change.
      setLockedInHoldingCell(roundLock || null);
      if (roundLock) {
        pushToast(
          roundLock.id === socket.id
            ? (languageRef.current === 'ru' ? 'Вы заперты в Камере на этот раунд.' : 'You are locked in the Holding Cell for this round.')
            : (languageRef.current === 'ru' ? `${roundLock.nickname} заперт в Камере на этот раунд.` : `${roundLock.nickname} is locked in the Holding Cell this round.`)
        );
      }
    }

    // The backend owns the entire cinematic clock. This handler only applies the
    // current micro-phase; it never chains local timers or predicts the next one.
    function onPhaseState({ code, phase, phaseStartTime, round, trial, players, findings, lockedInHoldingCell: roundLock }) {
      if (!phase) return;
      // A reconnect can receive phase state before a room update. Preserve the
      // authoritative room code so trial controls are never left without it.
      if (code) gameRoomCodeRef.current = code;
      phaseSyncRef.current = { phase, phaseStartTime: phaseStartTime || now() };
      if (typeof findings !== 'undefined') {
        setTrialFindings(findings || null);
      }
      // Same public holding-cell info as 'round_start', but synced silently
      // here (no toast) — this fires on reconnect/refresh too, not just when
      // the lock is genuinely new.
      setLockedInHoldingCell(roundLock || null);
      if (phase === 'TRANSITION_TO_TRIAL') {
        // End of the exploration/action phase: fade the exploration ambience
        // out smoothly during the blackout, ahead of the official displayPhase
        // switch (which only happens later, at TRIAL_VOTING).
        setCinematic({ mode: 'blackout', text: null, accent: 'cyan' });
        fadeAudio(explorationAudioRef.current, 0, 2000, true);
        setCurrentTurnPlayerId(null);
        setTurnEndsAt(null);
      } else if (phase === 'TRIAL_ANNOUNCEMENT') {
        setCinematic({ mode: 'announcement', text: languageRef.current === 'ru' ? 'НАЧИНАЕТСЯ ФАЗА СУДА' : 'TRIAL PHASE COMMENCING', accent: 'cyan' });
      } else if (phase === 'TRIAL_VOTING') {
        setGameData(prev => ({ ...prev, round: round ?? prev.round, phase: 'trial' }));
        setDisplayPhase('trial');
        setTrialData(prev => ({ ...(prev || {}), status: 'voting', confirmedVoterIds: trial?.confirmedVoterIds || [], totalEligible: trial?.eligibleVoterIds?.length || 0, eligibleVoterIds: trial?.eligibleVoterIds || [], candidates: trial?.candidates || [] }));
        setTrialEndsAt(trial?.endsAt || null);
        setTrialTimeLeft(trial?.endsAt ? Math.ceil((trial.endsAt - now()) / 1000) : null);
        setTrialPlayers(players || []);
        // Voting is interactive: remove the cinematic synchronously so a stale
        // blackout can never cover the voting panel after a missed transition.
        setCinematic(null);
        // Smooth fade-in of the trial ambience as voting begins.
        playAmbient(trialAudioRef.current, 2000);
      } else if (phase === 'TRIAL_RESOLUTION') {
        // End of the trial phase: fade the trial ambience out smoothly during
        // the verdict cinematic, ahead of the official displayPhase switch
        // back to 'action' (which only happens later, at EXPLORATION).
        const result = trial?.result || null;
        setTrialData(prev => ({ ...(prev || {}), status: 'resolved', result }));
        fadeAudio(trialAudioRef.current, 0, 2000, true);
        setCinematic({
          mode: 'resolution',
          text: result?.eliminatedPlayer || result?.executed
            ? `${result.eliminatedPlayer?.nickname || result.targetName || 'AGENT'} ELIMINATED FROM THE SECTOR`
            : 'VOTING SKIPPED - NO AGENT ELIMINATED',
          accent: 'magenta'
        });
      } else if (phase === 'EXPLORATION') {
        setGameData(prev => ({ ...prev, round: round ?? prev.round, phase: 'action' }));
        setDisplayPhase('action');
        setCinematic({ mode: 'reveal', text: null, accent: 'cyan' });
        // Smooth fade-in of the exploration ambience as the new round starts.
        playAmbient(explorationAudioRef.current, 2000);
      }
    }

    // A specific player's turn started — endsAt is used for the client-side
    // countdown. Also reset the mansion map: a new turn means a fresh fog of war,
    // nothing from the previous turn (including another player's) carries over.
    function onTurnStart({ playerId, endsAt, duration, skipped }) {
      console.log('CLIENT turn_start:', playerId, skipped ? '(auto-skipped — Holding Cell, no timer)' : '');
      // The Holding Cell player's "turn" is auto-skipped server-side with no
      // timer at all (see startPlayerTurn) — there is nothing for anyone's
      // UI to show or react to for it. Leave the current turn screen exactly
      // as it was and just wait for the next real turn_start, so nobody ever
      // sees a flash of "AN AGENT IS ACTING" / a 0s timer for a turn that
      // never actually happens.
      if (skipped) return;
      setCurrentTurnPlayerId(playerId);
      setTurnEndsAt(endsAt);
      setTurnTimeLeft(duration);
      setVentUsedThisTurn(false);
      // A brand-new turn can never carry over a stale post-kill modal — the
      // server itself auto-resolves any dangling decision the instant a turn
      // ends (see 'advanceTurn' server-side), so there's never a legitimate
      // pending decision left over here.
      setPendingKillDecision(null);
      setResolvingKill(false);
      // A brand-new turn cancels any leftover "leaving the room in Xs" countdown
      // from the previous player's turn.
      clearAutoEndCountdown();
      setMansionFloor(1);
      setRevealedRoom(null);
      setRoomChosen(false);
      setRoomActionTaken(false);
      setInvestigateUsedThisTurn(false);
    }

    // Round ended, trial phase started (placeholder for the first part of this mechanic)
    function onTrialStart({ code, endsAt, eligibleVoterIds, candidates, players }) {
      console.log('CLIENT trial_start received');
      playTrialAlarm(0.55);
      if (code) gameRoomCodeRef.current = code;
      setGameData(prev => ({ ...prev, phase: 'trial' }));
      setDisplayPhase('trial');
      setCurrentTurnPlayerId(null);
      setTurnEndsAt(null);
      setTrialData({ status: 'voting', confirmedVoterIds: [], totalEligible: eligibleVoterIds?.length || 0, eligibleVoterIds: eligibleVoterIds || [], candidates: candidates || [] });
      setTrialEndsAt(endsAt || null);
      setTrialTimeLeft(endsAt ? Math.ceil((endsAt - now()) / 1000) : null);
      setTrialPlayers(players || []);
      setSelectedTrialPlayer(null);
      setTrialDraftTargetId(undefined);
      clearAutoEndCountdown();
      setCinematic(null);
    }

    function onTrialVoteUpdate({ confirmedVoterIds, totalEligible }) {
      setTrialData(prev => {
        const prevCount = prev?.confirmedVoterIds?.length || 0;
        if ((confirmedVoterIds || []).length > prevCount) playVoteLockSound(0.3);
        return { ...(prev || {}), status: 'voting', confirmedVoterIds: confirmedVoterIds || [], totalEligible: totalEligible ?? prev?.totalEligible };
      });
    }

    function onTrialRosterUpdate({ players }) {
      setTrialPlayers(players || []);
    }

    function onTrialPlayerList(players) {
      setTrialPlayers(Array.isArray(players) ? players : []);
    }

    function onTrialResult(result) {
      setTrialData(prev => ({ ...(prev || {}), status: 'resolved', result }));
    }

    function onTimerUpdate({ phase, remaining, endsAt }) {
      if (phase !== 'trial') return;
      setTrialTimeLeft(prevRemaining => {
        // Tick only on a genuine new integer-second boundary inside the last 10s,
        // so a fast reconnect burst of identical updates can't retrigger the sound.
        if (typeof remaining === 'number' && remaining > 0 && remaining <= 10 && remaining !== prevRemaining) {
          playTrialTickSound(0.32);
        }
        return remaining;
      });
      if (endsAt) setTrialEndsAt(endsAt);
    }

    function onChatMessage({ message }) {
      // Very soft ping so a busy chat doesn't turn into noise; skip pinging the
      // player's own outgoing messages since they already saw themselves send it.
      const isOwnMessage = message?.senderId && message.senderId === socket.id;
      if (!isOwnMessage) playChatPingSound(0.12);
      setChatMessages(prev => [...prev, message].slice(-80));
    }

    // Server confirmed this turn's room selection: the character has "moved" into
    // the room, the fog clears, and we know who's already there. The server has
    // also shortened the remaining turn time to `inspectMs` and will auto-advance
    // on its own — mirror that here as a small visible countdown so the player
    // knows the turn is about to end (it's cosmetic; the server is authoritative).
    function onRoomEntered(data) {
      console.log('CLIENT room_entered:', data);
      setRevealedRoom(data);
      setRoomChosen(true);
      // A fresh room — whether from a new 'select_room' or a mid-turn vent
      // hop — re-arms this turn's room-interaction phase.
      if (!data.spectator) setRoomActionTaken(false);
      if (!data.spectator) setInvestigateUsedThisTurn(false);
      if (!data.spectator) clearAutoEndCountdown();
      // An EXPOSED body (isHidden: false) is detectable just by walking in —
      // no explicit "SEARCH FOR BODY" needed, unlike a hidden one. Surface it
      // the same way search_body_result already does.
      if (Array.isArray(data.bodies) && data.bodies.length > 0) {
        playTrashFoundSound(0.2);
        data.bodies.forEach(body => pushToast(languageRef.current === 'ru' ? `Тело ${body.nickname} лежит здесь, на виду.` : `${body.nickname}'s body is lying here, exposed.`));
      }
    }

    function onSpectatorRoomUpdate({ roomId, occupants, bodies }) {
      setRevealedRoom(previous => previous?.roomId === roomId ? { ...previous, occupants, bodies: bodies || [] } : previous);
    }

    // Private to the Joker only: whether 'plant_joker_evidence' is off cooldown
    // for their turn that's just starting (see startPlayerTurn on the server).
    function onJokerEvidenceStatus({ available, turnsRemaining }) {
      setJokerEvidenceStatus({ available: Boolean(available), turnsRemaining: turnsRemaining ?? 0 });
    }

    // Result of this player's own 'plant_joker_evidence' attempt, fired after
    // picking a room in the picker modal (see handlePlantJokerEvidence) — the
    // modal closes either way once a definitive answer comes back.
    function onJokerEvidenceResult({ success, reason, turnsRemaining, clue }) {
      setJokerPlantSubmittingRoomId(null);
      if (success) {
        playEvidencePlantedSound(0.38);
        setJokerEvidenceStatus({ available: false, turnsRemaining: turnsRemaining ?? 3 });
        pushToast(languageRef.current === 'ru'
          ? `Улика подброшена в ${translateRoomName(clue?.roomName, languageRef.current) || 'комнате'}: "${translateEvidenceName(clue?.text, languageRef.current) || 'неизвестный предмет'}"`
          : `Evidence planted in ${clue?.roomName || 'the room'}: "${clue?.text || 'unknown item'}"`);
        setJokerPlantPickerOpen(false);
        setRevealedRoom(previous => previous && previous.roomId === clue?.roomId
          ? { ...previous, evidence: [...(previous.evidence || []), { id: clue.id, text: clue.text }] }
          : previous);
      } else if (reason === 'cooldown') {
        setJokerEvidenceStatus({ available: false, turnsRemaining: turnsRemaining ?? 0 });
        pushToast(languageRef.current === 'ru' ? `Подбрасывание улики на перезарядке ещё ${turnsRemaining} ход(а/ов).` : `Evidence planting is on cooldown for ${turnsRemaining} more turn(s).`);
        setJokerPlantPickerOpen(false);
      } else {
        pushToast(languageRef.current === 'ru' ? 'Не удалось подбросить улику — попробуйте другую комнату.' : 'Could not plant evidence there — try another room.');
      }
    }

    // Private to the Accomplice only: whether 'accomplice_change_evidence' is
    // off cooldown for their turn that's just starting (see startPlayerTurn
    // on the server). Mirrors onJokerEvidenceStatus above.
    function onAccompliceEvidenceStatus({ available, turnsRemaining }) {
      setAccompliceEvidenceStatus({ available: Boolean(available), turnsRemaining: turnsRemaining ?? 0 });
    }

    // Private to the Accomplice only: whether 'set_trap' is off cooldown for
    // their turn that's just starting (see startPlayerTurn on the server).
    // Mirrors onAccompliceEvidenceStatus above, but this cooldown is measured
    // in whole game rounds (roundsRemaining) rather than the Accomplice's own
    // turns.
    function onTrapStatus({ available, roundsRemaining }) {
      setAccompliceTrapStatus({ available: Boolean(available), roundsRemaining: roundsRemaining ?? 0 });
    }

    // Result of this Accomplice's own 'accomplice_change_evidence' attempt,
    // fired after picking a target in the "CHANGE EVIDENCE" modal (see
    // handleSubmitChangeEvidence) — the modal closes either way once a
    // definitive answer comes back. On success, the altered evidence's new
    // text is patched directly into revealedRoom.evidence in place so the
    // panel updates instantly without waiting for a fresh room_entered.
    function onAccompliceEvidenceResult({ success, reason, turnsRemaining, evidence }) {
      setChangeEvidenceSubmittingTargetId(null);
      if (success) {
        playEvidencePlantedSound(0.38);
        setAccompliceEvidenceStatus({ available: false, turnsRemaining: turnsRemaining ?? 3 });
        pushToast(languageRef.current === 'ru'
          ? `Улика изменена: "${translateEvidenceName(evidence?.text, languageRef.current) || 'неизвестный предмет'}"`
          : `Evidence altered: "${evidence?.text || 'unknown item'}"`);
        setChangeEvidencePickerOpen(false);
        setChangeEvidenceTargetEvidenceId(null);
        setRoomActionTaken(true);
        setRevealedRoom(previous => previous
          ? {
              ...previous,
              evidence: (previous.evidence || []).map(item =>
                item.id === evidence?.id ? { ...item, text: evidence.text } : item
              )
            }
          : previous);
      } else if (reason === 'cooldown') {
        setAccompliceEvidenceStatus({ available: false, turnsRemaining: turnsRemaining ?? 0 });
        pushToast(languageRef.current === 'ru' ? `«Изменить улику» на перезарядке ещё ${turnsRemaining} ход(а/ов).` : `Change Evidence is on cooldown for ${turnsRemaining} more turn(s).`);
        setChangeEvidencePickerOpen(false);
      } else {
        pushToast(languageRef.current === 'ru' ? 'Не удалось изменить эту улику — попробуйте снова.' : 'Could not alter that evidence — try again.');
      }
    }

    // Result of this Accomplice's own 'set_trap' attempt, fired after picking
    // a room in the "SET A TRAP" picker modal (see handleChooseAccompliceTrapRoom)
    // — the modal closes either way once a definitive answer comes back.
    // Mirrors onJokerEvidenceResult above; the trap itself doesn't do
    // anything yet beyond being recorded, and its cooldown is round-based
    // (roundsRemaining) rather than own-turn-based.
    function onSetTrapResult({ success, reason, roundsRemaining, trap }) {
      setAccompliceTrapSubmittingRoomId(null);
      if (success) {
        playAbilityUseSound(0.75);
        setAccompliceTrapStatus({ available: false, roundsRemaining: roundsRemaining ?? 4 });
        pushToast(languageRef.current === 'ru' ? `Ловушка установлена в ${translateRoomName(trap?.roomName, languageRef.current) || 'комнате'}.` : `Trap set in ${trap?.roomName || 'the room'}.`);
        setAccompliceTrapPickerOpen(false);
      } else if (reason === 'cooldown') {
        setAccompliceTrapStatus({ available: false, roundsRemaining: roundsRemaining ?? 0 });
        pushToast(languageRef.current === 'ru' ? `«Установить ловушку» на перезарядке ещё ${roundsRemaining} раунд(а/ов).` : `Set a Trap is on cooldown for ${roundsRemaining} more round(s).`);
        setAccompliceTrapPickerOpen(false);
      } else {
        pushToast(languageRef.current === 'ru' ? 'Не удалось установить ловушку — попробуйте другую комнату.' : 'Could not set a trap there — try another room.');
      }
    }

    // Fires the instant this player walks into a mansion room holding an
    // unsprung trap (see 'set_trap' / triggerTrapIfPresent server-side) — pops
    // the warning modal. The trap is already consumed server-side by the time
    // this arrives, so there's nothing to do here besides show the message;
    // the actual lockout is applied separately via trap_debuff_status once
    // the penalty round starts.
    function onTrapTriggered({ roomName }) {
      setTrapTriggeredInfo({ roomName });
    }

    // Private, authoritative "am I locked out this round" flag — see
    // isPlayerTrapDebuffed / emitTrapDebuffStatus server-side. Sent at the
    // start of both the action phase and the Court/Trial phase, plus on
    // reconnect, so this always reflects the server's current answer rather
    // than something derived client-side from trap_triggered's timing.
    function onTrapDebuffStatus({ active }) {
      setTrapDebuffActive(Boolean(active));
    }

    // Fallback safety net: if a debuffed player's client somehow still lets
    // them fire off an action/ability (stale UI, race on phase change), the
    // server rejects it and this lets them know why instead of it just
    // silently doing nothing.
    function onTrapDebuffBlocked() {
      pushToast(languageRef.current === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде действия и способности недоступны.' : "You're still recovering from the trap — no actions or abilities this round.");
    }

    // Accomplice-only: fires whenever their own Killer's accidental evidence
    // drop lands (see the killerClue block in 'resolve_kill' server-side) —
    // a private heads-up between the two Killer-team members, same privacy
    // rule as killerClue itself. A simple toast is enough here; unlike
    // trap_triggered above there's no decision or lasting state attached.
    function onAccompliceKillerClueNotice({ roomName, text }) {
      pushToast(languageRef.current === 'ru'
        ? `Ваш Убийца случайно оставил улику: "${translateEvidenceName(text, languageRef.current) || 'предмет'}" в ${translateRoomName(roomName, languageRef.current) || 'комнате'}.`
        : `Your Killer accidentally left evidence behind: "${text || 'an item'}" in ${roomName || 'a room'}.`);
    }

    // Killer-only: fires whenever their own Accomplice sets a trap (see
    // 'set_trap' server-side) — mirrors onAccompliceKillerClueNotice above,
    // just going the other direction within the same Killer/Accomplice pair.
    function onKillerTrapNotice({ roomName }) {
      pushToast(languageRef.current === 'ru' ? `Ваш Сообщник установил ловушку в ${translateRoomName(roomName, languageRef.current) || 'комнате'}.` : `Your Accomplice set a trap in ${roomName || 'a room'}.`);
    }

    // Private to the Detective only: whether 'detective_check_location' is off
    // cooldown for this Court/Trial phase that's just starting (see
    // activateTrialVoting on the server).
    function onDetectiveAbilityStatus({ available, turnsRemaining }) {
      setDetectiveAbilityStatus({ available: Boolean(available), turnsRemaining: turnsRemaining ?? 0 });
    }

    // Result of this Detective's own 'detective_check_location' request, fired
    // after clicking "Check Location" on a suspect's card during the trial.
    // On success this is the ONLY place the room name ever surfaces — nothing
    // is broadcast, so no other player, including the one checked, ever learns
    // this ability was used.
    function onDetectiveCheckResult({ success, reason, turnsRemaining, targetNickname, roomName }) {
      if (success) {
        setDetectiveAbilityStatus({ available: false, turnsRemaining: turnsRemaining ?? 2 });
        setDetectiveCheckResult({ targetNickname, roomName });
      } else if (reason === 'cooldown') {
        setDetectiveAbilityStatus({ available: false, turnsRemaining: turnsRemaining ?? 0 });
        pushToast(languageRef.current === 'ru' ? `Способность обыска на перезарядке ещё ${turnsRemaining} раунд(а/ов).` : `Investigation ability on cooldown for ${turnsRemaining} more round(s).`);
      }
    }

    // Private to the Officer only: whether 'officer_lock_player' is off
    // cooldown for this Court/Trial phase that's just starting (see
    // activateTrialVoting on the server).
    function onOfficerAbilityStatus({ available, turnsRemaining }) {
      setOfficerAbilityStatus({ available: Boolean(available), turnsRemaining: turnsRemaining ?? 0 });
    }

    // Result of this Officer's own 'officer_lock_player' request, fired after
    // clicking "Lock in Cell" on a suspect's (or their own) card during the
    // trial. On success this is the ONLY place the confirmation surfaces —
    // nothing is broadcast yet; the target (and everyone else) only learns
    // about it once the locked round actually starts (see 'round_start').
    function onOfficerLockResult({ success, reason, turnsRemaining, targetNickname }) {
      if (success) {
        setOfficerAbilityStatus({ available: false, turnsRemaining: turnsRemaining ?? 3 });
        setOfficerLockResult({ targetNickname });
      } else if (reason === 'cooldown') {
        setOfficerAbilityStatus({ available: false, turnsRemaining: turnsRemaining ?? 0 });
        pushToast(languageRef.current === 'ru' ? `Протокол задержания на перезарядке ещё ${turnsRemaining} раунд(а/ов).` : `Detainment protocol on cooldown for ${turnsRemaining} more round(s).`);
      }
    }

    // Result of investigating the currently-peeked room (see handleInvestigateRoom).
    // What we show depends entirely on `type`, which the server already decided
    // based on role — the client never had, and never needs, the digit itself
    // unless `type === 'fragment'`. `evidence` (anything the Joker has planted
    // here) only ever arrives THROUGH this event — i.e. only once the player
    // actually clicks INVESTIGATE ROOM, never just from walking in.
    function onInvestigateResult({ roomId, type, digit, position, totalDigits, foundBy, selfFound, evidence, neurotoxin }) {
      console.log('CLIENT investigate_result:', { roomId, type, position, totalDigits, foundBy, selfFound, evidence, neurotoxin });

      // --- NEUROTOXIN-7: pickup is folded into 'investigate_room' server-side
      // (see the backend's investigate_room handler) — this is the ONLY place
      // a pickup/blocked-pickup result for it ever arrives. Previously this
      // field was silently dropped here, so the syringe would vanish from the
      // room (server marks it pickedUp / leaves it in place) with zero
      // feedback to the player. 'picked_up' gets the dedicated popup (same
      // one item:interact:result uses); the other outcomes get a normal toast.
      if (neurotoxin) {
        if (neurotoxin.outcome === 'picked_up') {
          showNeurotoxinPopup(pickLocalizedMessage(neurotoxin.message));
          setNeurotoxinCarried({ killsInCurrentRound: 0 });
        } else if (neurotoxin.outcome === 'restricted_role' || neurotoxin.outcome === 'already_carrying') {
          pushToast(pickLocalizedMessage(neurotoxin.message));
        }
      }
      if (type === 'fragment') {
        setCodeTotalDigits(totalDigits ?? null);
        setFoundFragments(prev => prev.some(f => f.position === position)
          ? prev
          : [...prev, { position, digit }].sort((a, b) => a.position - b.position));
        if (selfFound) playFragmentFoundSound(0.5);
        pushToast(languageRef.current === 'ru'
          ? (selfFound
              ? `Фрагмент ${position}/${totalDigits}: "${digit}"`
              : `Кто-то нашёл фрагмент ${position}/${totalDigits}: "${digit}"`)
          : (selfFound
              ? `Fragment ${position}/${totalDigits}: "${digit}"`
              : `Someone found Fragment ${position}/${totalDigits}: "${digit}"`));
      } else if (type === 'trash') {
        playTrashFoundSound(0.2);
        pushToast(languageRef.current === 'ru' ? 'Вы нашли скомканный лист бумаги. Похоже на бесполезный мусор.' : 'You found a crumpled piece of paper. It looks like useless trash.');
      } else if (Array.isArray(evidence) && evidence.length > 0) {
        // No digital code fragment here, but the Joker left evidence behind —
        // skip the "nothing" message so it doesn't contradict the evidence
        // toast fired below.
      } else {
        playTrashFoundSound(0.14);
        pushToast(languageRef.current === 'ru' ? 'В этой комнате не нашлось ничего интересного.' : 'Nothing of interest found in this room.');
      }

      if (Array.isArray(evidence) && evidence.length > 0) {
        setRevealedRoom(previous => previous && previous.roomId === roomId
          ? { ...previous, evidence }
          : previous);
        evidence.forEach(item => pushToast(languageRef.current === 'ru' ? `Найдена улика: ${translateEvidenceName(item.text, languageRef.current)}` : `Evidence found: ${item.text}`));
      }
    }

    // Mark Room (Innocent only): another Innocent just checked a room via
    // 'check_room' — only ever arrives for Innocent sockets (and only to
    // teammates OTHER than whoever actually clicked CHECK ROOM, see
    // 'check_room_result' below for their own confirmation), so no role
    // check is needed client-side. Deliberately anonymous — the server never
    // tells us who checked it, only that it was checked. Fires the SAME
    // generic toast regardless of whether a code fragment was actually in
    // there, so it never leaks that info to teammates. `cleared` only drives
    // the green "already checked, no code here" highlight, which is kept
    // permanently (never cleared on turn_start) so it stays accurate for the
    // whole match.
    function onRoomMarkedClean({ roomId, roomName, cleared }) {
      if (cleared) {
        setClearedRoomIds(prev => (prev[roomId] ? prev : { ...prev, [roomId]: { roomName: roomName || roomId } }));
      }
      pushToast(languageRef.current === 'ru' ? `${translateRoomName(roomName, languageRef.current) || 'Комната'} проверена.` : `${roomName || 'A room'} has been checked.`);
    }

    // Result of this Innocent's own 'check_room' attempt (see handleCheckRoom).
    // No success toast here — Check Room is a logging/sharing action for the
    // player's OWN room, taken after INVESTIGATE ROOM already told them what's
    // there, so a "Room checked" toast to themselves would just be confirming
    // something they already know they just did. Only failure reasons are
    // worth surfacing.
    function onCheckRoomResult({ success, reason, cleared, roomId, roomName, turnsRemaining }) {
      setCheckRoomSubmitting(false);
      if (!success) {
        if (reason === 'cooldown') {
          setMarkRoomStatus({ available: false, turnsRemaining: turnsRemaining ?? 0 });
          pushToast(languageRef.current === 'ru' ? `«Проверить комнату» на перезарядке ещё ${turnsRemaining} раунд(а/ов).` : `Check Room on cooldown for ${turnsRemaining} more round(s).`);
        } else if (reason === 'investigate_required') {
          setInvestigateUsedThisTurn(false);
          pushToast(languageRef.current === 'ru' ? 'Сначала обыщите эту комнату.' : 'Investigate this room first.');
        }
        return;
      }

      setMarkRoomStatus({ available: false, turnsRemaining: turnsRemaining ?? 2 });
      if (cleared) {
        setClearedRoomIds(prev => (prev[roomId] ? prev : { ...prev, [roomId]: { roomName: roomName || roomId } }));
      }
    }

    // Privately tells the Innocent whether 'check_room' is off its 2-round
    // cooldown, refreshed at the start of every one of their own turns.
    function onMarkRoomStatus({ available, turnsRemaining }) {
      setMarkRoomStatus({ available: Boolean(available), turnsRemaining: turnsRemaining ?? 0 });
    }

    // Result of searching the currently-peeked room for a body (see
    // handleSearchBody). `bodies` only arrives when found is true — one entry
    // per executed player who happened to be standing here when the council
    // voted them out.
    function onSearchBodyResult({ roomId, found, bodies }) {
      console.log('CLIENT search_body_result:', { roomId, found, bodies });
      if (found && Array.isArray(bodies) && bodies.length > 0) {
        // Same "found it" cue as a successful room investigation
        // (see onInvestigateResult's selfFound branch) — a found body is a
        // hit just like a found code fragment, so it gets the identical
        // bright confirm sound instead of the dull "nothing much" one.
        playFragmentFoundSound(0.5);
        bodies.forEach(body => pushToast(languageRef.current === 'ru' ? `Вы нашли здесь тело ${body.nickname}!` : `You found ${body.nickname}'s body here!`));
        // A newly-found hidden body should show up exactly like an already-exposed
        // one — the same big crossed-out icon in the room scene and the same pill
        // row — rather than only ever surfacing as a toast. Merge it into
        // revealedRoom.bodies, deduped by nickname so a repeat search of the same
        // room doesn't add duplicates.
        setRevealedRoom(previous => {
          if (!previous || previous.roomId !== roomId) return previous;
          const existing = previous.bodies || [];
          const merged = [...existing];
          bodies.forEach(body => {
            if (!merged.some(b => b.nickname === body.nickname)) merged.push(body);
          });
          return { ...previous, bodies: merged };
        });
      } else {
        playTrashFoundSound(0.14);
        pushToast(languageRef.current === 'ru' ? 'В этой комнате тел не обнаружено.' : 'No bodies found in this room.');
      }
    }

    // Picks the string matching the app's active language from a server-sent
    // { en, ru } pair — same idiom as the rest of this file's inline
    // `languageRef.current === 'ru' ? ... : ...` toasts, just reusable since
    // every Neurotoxin-7 message arrives pre-paired from the server.
    function pickLocalizedMessage(pair) {
      return languageRef.current === 'ru' ? pair.ru : pair.en;
    }

    // NOTE: Neurotoxin-7 pickup is resolved entirely inside 'investigate_result'
    // (see onInvestigateResult's `neurotoxin` handling above) — the backend has
    // no handler for a separate 'item:interact' event, so this event and its
    // reply were removed here as dead code that never actually fired.

    // Fatal-hit result: only fires with negated: true when the Accomplice/
    // Joker passive shield actually triggered.
    function onPlayerTakeFatalHitResult(data) {
      if (!data.negated) return;
      console.log('CLIENT player:takeFatalHit:result:', data);
      pushToast(pickLocalizedMessage(data.message));
      setNeurotoxinCarried(null);
    }

    // Killer only: the kill just landed server-side (see handleKillPlayer) —
    // this opens the mandatory post-kill modal. Only the Killer's own socket
    // ever receives this event.
    function onKillOptions({ targetId, targetNickname, roomId, targetCharacter, negatedByShield, neurotoxinMessage }) {
      console.log('CLIENT kill_options:', { targetId, targetNickname, roomId });

      // The target was carrying an unconsumed Neurotoxin-7 shield: the kill
      // never landed server-side, so there is no body/decision to resolve —
      // just tell the Killer their attack failed and stop here.
      if (negatedByShield) {
        pushToast(languageRef.current === 'ru'
          ? `Атака на ${targetNickname} не удалась — цель защищена.`
          : `Attack on ${targetNickname} failed — target is shielded.`);
        return;
      }

      // First/second kill this round while carrying the item (see
      // applyNeurotoxinOnKill-equivalent server logic in 'kill_player').
      if (neurotoxinMessage) {
        pushToast(pickLocalizedMessage(neurotoxinMessage));
        setNeurotoxinCarried(prev => {
          if (!prev) return prev;
          const nextKills = prev.killsInCurrentRound + 1;
          return nextKills >= 2 ? null : { killsInCurrentRound: nextKills };
        });
      }

      playKillSound(0.9);
      setResolvingKill(false);
      setPendingKillDecision({ targetId, targetNickname, roomId });
      // The kill lands the instant the server confirms it — regardless of what
      // the Killer later chooses to do with the body (hide/expose), THEY
      // already know the victim is dead and where. So their own view updates
      // right away: the victim drops out of the living-occupants list and
      // appears as a crossed-out body instead, without waiting on a search.
      // Only the Killer's socket ever receives 'kill_options', so this never
      // reveals anything to anyone else — other players still only learn about
      // the body the normal way (exposed on room entry, or via SEARCH FOR BODY).
      setRevealedRoom(previous => {
        if (!previous || previous.roomId !== roomId) return previous;
        const victimOccupant = (previous.occupants || []).find(o => o.id === targetId);
        const occupants = (previous.occupants || []).filter(o => o.id !== targetId);
        const existingBodies = previous.bodies || [];
        if (existingBodies.some(b => b.playerId === targetId || b.nickname === targetNickname)) {
          return { ...previous, occupants };
        }
        return {
          ...previous,
          occupants,
          // playerId matches the id the victim was occupying the room under a
          // moment ago, so RoomVisualScene's position cache treats this as the
          // very same entity and keeps it right where it already was standing.
          // Carry over the same server-assigned x/y the occupant already had,
          // so the marker doesn't jump to a new spot the instant they die.
          bodies: [...existingBodies, {
            playerId: targetId,
            nickname: targetNickname,
            character: targetCharacter || null,
            x: victimOccupant?.x,
            y: victimOccupant?.y
          }]
        };
      });
    }

    // Killer only: the server has confirmed a post-kill decision (see
    // handleResolveKill). Closes the modal either way. Hiding the body spends
    // this turn's vent hop server-side (see 'resolve_kill'), so mirror that
    // locally the same way a real 'use_vent' hop already does.
    function onKillResolved({ action, roomId, targetId, killerClue }) {
      console.log('CLIENT kill_resolved:', { action, roomId, targetId, killerClue });
      setPendingKillDecision(null);
      setResolvingKill(false);
      // Killer-only: the server rolled its dynamic drop-chance (scales with
      // lobby size and kills-so-far, see getEvidenceDropChance on the
      // backend) and decided a personal
      // item was accidentally left behind (see 'resolve_kill' server-side).
      // Nobody else's client ever receives this — it's private to the Killer,
      // same treatment as the joker_evidence_result toast below.
      if (killerClue) {
        pushToast(languageRef.current === 'ru'
          ? `Вы оставили улику в ${translateRoomName(killerClue.roomName, languageRef.current)}: "${translateEvidenceName(killerClue.text, languageRef.current)}"`
          : `You left behind a clue in ${killerClue.roomName}: "${killerClue.text}"`);
      }
      if (action === 'hide') {
        setVentUsedThisTurn(true);
        pushToast(languageRef.current === 'ru' ? 'Тело спрятано. Теперь его найдут только при обыске — вентиляция в этот ход недоступна.' : 'Body hidden. Only a search will find it now — vent unavailable this turn.');
        // 'kill_options' (see onKillOptions) already dropped the body marker
        // into the Killer's own view the instant the kill landed, regardless
        // of what they'd later choose to do with it. A hidden body is only
        // ever supposed to surface via an explicit "SEARCH FOR BODY" — so
        // once the Killer picks "hide", pull that marker back out of their
        // own room view too. Without this the body kept showing up on the
        // Killer's screen even after choosing to hide it.
        setRevealedRoom(previous => {
          if (!previous || previous.roomId !== roomId) return previous;
          return {
            ...previous,
            bodies: (previous.bodies || []).filter(b => b.playerId !== targetId)
          };
        });
      } else {
        pushToast(languageRef.current === 'ru' ? 'Тело оставлено на виду в комнате.' : 'Body left exposed in the room.');
      }
    }

    // Broadcast to the whole room the instant a Killer's target goes down —
    // isEliminated/isObserver themselves already arrive via the accompanying
    // 'room_updated'. No toast/popup here anymore (deliberately silent —
    // other players shouldn't be told out loud that a kill just happened).
    // Sound is deliberately NOT played here: the murder sound is an "own
    // action" cue that only the Killer hears, fired privately via
    // onKillOptions below — other players/the victim never hear it.
    function onPlayerEliminated({ targetId, nickname }) {
      console.log('CLIENT player_eliminated:', { targetId, nickname });
    }

    // The server's authoritative snapshot of the shared CLUES board — sent
    // both proactively (whenever someone newly discovers a piece of evidence,
    // see 'investigate_room' server-side) and on demand (see handleOpenClues,
    // which asks via 'get_clues_board' the moment the panel is opened). Always
    // a full replace, never a delta, so it's safe to just swap the array in.
    function onCluesBoardUpdate({ clues: nextClues }) {
      console.log('CLIENT clues_board_update:', nextClues);
      setClues(Array.isArray(nextClues) ? nextClues : []);
    }

    // Private to the Forensic Examiner only: whether either Forensic ability is
    // off cooldown. The server emits the same status payload for both
    // 'verify_evidence' and 'examine_body' under a shared round-based tracker.
    function onForensicAbilityStatus({ available, roundsRemaining }) {
      setForensicVerifyStatus({ available: Boolean(available), roundsRemaining: roundsRemaining ?? 0 });
    }

    function onForensicVerifyStatus({ available, roundsRemaining }) {
      onForensicAbilityStatus({ available, roundsRemaining });
    }

    // Forensic Examiner only: the server's answer to a single 'verify_evidence'
    // request (see handleVerifyEvidence). A cooldown rejection updates the
    // status badge and shows a toast just like the Detective's/Officer's
    // round-based cooldowns (this shared cooldown is round-based, not tied to
    // the Forensic's own turns); any other failure (e.g. the clue vanished
    // from the board in the meantime) just silently clears the loading state
    // with no result shown.
    function onVerifyEvidenceResult({ success, reason, roundsRemaining, evidenceId, text, isAuthentic }) {
      console.log('CLIENT verify_evidence_result:', { success, reason, roundsRemaining, evidenceId, text, isAuthentic });
      setForensicVerifyingId(null);
      if (success) {
        setForensicVerifyStatus({ available: false, roundsRemaining: roundsRemaining ?? 3 });
        setForensicVerifyResult({ evidenceId, text, isAuthentic });
      } else if (reason === 'cooldown') {
        setForensicVerifyStatus({ available: false, roundsRemaining: roundsRemaining ?? 0 });
        pushToast(languageRef.current === 'ru' ? `Проверка улики на перезарядке ещё ${roundsRemaining} раунд(а/ов).` : `Evidence verification is on cooldown for ${roundsRemaining} more round(s).`);
      }
    }

    function onExamineBodyResult({ success, reason, roundsRemaining, clue, bodyId, report }) {
      console.log('CLIENT examine_body_result:', { success, reason, roundsRemaining, clue, bodyId, report });
      if (success) {
        setForensicVerifyStatus({ available: false, roundsRemaining: roundsRemaining ?? 0 });
        setForensicSavedReport(report || null);
        setForensicReportUnlocked(true);
        setForensicBodyExamineResult({ bodyId, clue });
      } else if (reason === 'cooldown') {
        setForensicVerifyStatus({ available: false, roundsRemaining: roundsRemaining ?? 0 });
        pushToast(languageRef.current === 'ru' ? `Осмотр тела на перезарядке ещё ${roundsRemaining} раунд(а/ов).` : `Body examination is on cooldown for ${roundsRemaining} more round(s).`);
      } else if (reason === 'invalid_body') {
        pushToast(languageRef.current === 'ru' ? 'Это тело сейчас нельзя осмотреть.' : 'That body cannot be examined right now.');
      }
    }

    function onForensicReport({ success, reason, report }) {
      if (!success) {
        if (reason === 'no_report') {
          pushToast(languageRef.current === 'ru' ? 'Криминалистический отчёт ещё не сохранён.' : 'No forensic report has been saved yet.');
          setForensicBodyExamineResult(null);
        }
        return;
      }
      setForensicSavedReport(report || null);
      setForensicReportUnlocked(true);
      setForensicBodyExamineResult({
        bodyId: report?.bodyId || null,
        clue: report ? { type: report.type, value: report.value } : null
      });
    }

    // Whether the override terminal is currently usable at all (see
    // hasUndiscoveredBody / broadcastExitStatus on the server) — a Killer
    // victim nobody has found yet physically seals the exit, correct code or
    // not. Kept in sync live so the terminal disables itself the moment a
    // kill lands, not just after a failed submit.
    function onExitStatus({ sealed }) {
      console.log('CLIENT exit_status:', sealed);
      setExitSealed(Boolean(sealed));
    }

    // Server rejected the code just submitted via the override terminal — reset
    // the draft input and surface the exact same generic notice regardless of
    // why it failed (wrong digits, empty, etc.).
    function onCodeSubmissionResult({ success, message, reason }) {
      console.log('CLIENT code_submission_result:', { success, message, reason });
      if (!success) {
        playCodeErrorSound(0.4);
        pushToast(translateCodeSubmissionMessage({ message, reason }, languageRef.current));
        setCodeGuess('');
      }
    }

    // The match just ended (currently: an Innocent cracked the code). Show the
    // GAME_OVER summary; the server will reset the room and emit 'room_joined'
    // on its own after the summary has had time to display — no local timer
    // needed on this side, and onRoomJoined already clears gameOverData.
    function onGameOver(data) {
      console.log('CLIENT game_over:', data);
      playGameOverSting(0.95);
      setGameOverData(data);
      setCinematic(null);
      setCodeGuess('');
    }

    setIsConnected(socket.connected);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('rooms_list', onRoomsList);
    socket.on('room_joined', onRoomJoined);
    socket.on('join_error', onJoinError);
    socket.on('room_updated', onRoomUpdated);
    socket.on('countdown_tick', onCountdownTick);
    socket.on('countdown_cancel', onCountdownCancel);
    socket.on('game_start', onGameStart);
    socket.on('intro_start', onIntroStart);
    socket.on('skip_intro_update', onSkipIntroUpdate);
    socket.on('intro_skip', onIntroSkip);
    socket.on('role_assigned', onRoleAssigned);
    socket.on('game_started', onGameStarted);
    socket.on('round_start', onRoundStart);
    socket.on('phase_state', onPhaseState);
    socket.on('turn_start', onTurnStart);
    socket.on('trial_start', onTrialStart);
    socket.on('trial_vote_update', onTrialVoteUpdate);
    socket.on('trial_roster_update', onTrialRosterUpdate);
    socket.on('trial_player_list', onTrialPlayerList);
    socket.on('trial_result', onTrialResult);
    socket.on('timer_update', onTimerUpdate);
    socket.on('chat_message', onChatMessage);
    socket.on('room_entered', onRoomEntered);
    socket.on('spectator_room_update', onSpectatorRoomUpdate);
    socket.on('investigate_result', onInvestigateResult);
    socket.on('room_marked_clean', onRoomMarkedClean);
    socket.on('check_room_result', onCheckRoomResult);
    socket.on('mark_room_status', onMarkRoomStatus);
    socket.on('search_body_result', onSearchBodyResult);
    socket.on('player:takeFatalHit:result', onPlayerTakeFatalHitResult);
    socket.on('kill_options', onKillOptions);
    socket.on('kill_resolved', onKillResolved);
    socket.on('player_eliminated', onPlayerEliminated);
    socket.on('code_submission_result', onCodeSubmissionResult);
    socket.on('exit_status', onExitStatus);
    socket.on('joker_evidence_status', onJokerEvidenceStatus);
    socket.on('joker_evidence_result', onJokerEvidenceResult);
    socket.on('accomplice_evidence_status', onAccompliceEvidenceStatus);
    socket.on('accomplice_evidence_result', onAccompliceEvidenceResult);
    socket.on('trap_status', onTrapStatus);
    socket.on('set_trap_result', onSetTrapResult);
    socket.on('trap_triggered', onTrapTriggered);
    socket.on('trap_debuff_status', onTrapDebuffStatus);
    socket.on('trap_debuff_blocked', onTrapDebuffBlocked);
    socket.on('accomplice_killer_clue_notice', onAccompliceKillerClueNotice);
    socket.on('killer_trap_notice', onKillerTrapNotice);
    socket.on('detective_ability_status', onDetectiveAbilityStatus);
    socket.on('detective_check_result', onDetectiveCheckResult);
    socket.on('officer_ability_status', onOfficerAbilityStatus);
    socket.on('officer_lock_result', onOfficerLockResult);
    socket.on('clues_board_update', onCluesBoardUpdate);
    socket.on('forensic_ability_status', onForensicAbilityStatus);
    socket.on('forensic_verify_status', onForensicVerifyStatus);
    socket.on('forensic_report', onForensicReport);
    socket.on('verify_evidence_result', onVerifyEvidenceResult);
    socket.on('examine_body_result', onExamineBodyResult);
    socket.on('game_over', onGameOver);

    // Re-check the clock offset periodically, not just once on connect — a
    // laptop coming back from sleep, a background tab getting throttled, or
    // the device clock adjusting mid-session can all reintroduce drift.
    const resyncInterval = setInterval(syncServerTime, 120000);

    return () => {
      clearInterval(resyncInterval);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('rooms_list', onRoomsList);
      socket.off('room_joined', onRoomJoined);
      socket.off('join_error', onJoinError);
      socket.off('room_updated', onRoomUpdated);
      socket.off('countdown_tick', onCountdownTick);
      socket.off('countdown_cancel', onCountdownCancel);
      socket.off('game_start', onGameStart);
      socket.off('intro_start', onIntroStart);
      socket.off('skip_intro_update', onSkipIntroUpdate);
      socket.off('intro_skip', onIntroSkip);
      socket.off('role_assigned', onRoleAssigned);
      socket.off('game_started', onGameStarted);
      socket.off('round_start', onRoundStart);
      socket.off('phase_state', onPhaseState);
      socket.off('turn_start', onTurnStart);
      socket.off('trial_start', onTrialStart);
      socket.off('trial_vote_update', onTrialVoteUpdate);
      socket.off('trial_roster_update', onTrialRosterUpdate);
      socket.off('trial_player_list', onTrialPlayerList);
      socket.off('trial_result', onTrialResult);
      socket.off('timer_update', onTimerUpdate);
      socket.off('chat_message', onChatMessage);
      socket.off('room_entered', onRoomEntered);
      socket.off('spectator_room_update', onSpectatorRoomUpdate);
      socket.off('investigate_result', onInvestigateResult);
      socket.off('room_marked_clean', onRoomMarkedClean);
      socket.off('check_room_result', onCheckRoomResult);
      socket.off('mark_room_status', onMarkRoomStatus);
      socket.off('search_body_result', onSearchBodyResult);
      socket.off('player:takeFatalHit:result', onPlayerTakeFatalHitResult);
      socket.off('kill_options', onKillOptions);
      socket.off('kill_resolved', onKillResolved);
      socket.off('player_eliminated', onPlayerEliminated);
      socket.off('code_submission_result', onCodeSubmissionResult);
      socket.off('exit_status', onExitStatus);
      socket.off('clues_board_update', onCluesBoardUpdate);
      socket.off('forensic_ability_status', onForensicAbilityStatus);
      socket.off('forensic_verify_status', onForensicVerifyStatus);
      socket.off('forensic_report', onForensicReport);
      socket.off('verify_evidence_result', onVerifyEvidenceResult);
      socket.off('examine_body_result', onExamineBodyResult);
      socket.off('joker_evidence_status', onJokerEvidenceStatus);
      socket.off('joker_evidence_result', onJokerEvidenceResult);
      socket.off('accomplice_evidence_status', onAccompliceEvidenceStatus);
      socket.off('accomplice_evidence_result', onAccompliceEvidenceResult);
      socket.off('trap_status', onTrapStatus);
      socket.off('set_trap_result', onSetTrapResult);
      socket.off('trap_triggered', onTrapTriggered);
      socket.off('trap_debuff_status', onTrapDebuffStatus);
      socket.off('trap_debuff_blocked', onTrapDebuffBlocked);
      socket.off('accomplice_killer_clue_notice', onAccompliceKillerClueNotice);
      socket.off('killer_trap_notice', onKillerTrapNotice);
      socket.off('detective_ability_status', onDetectiveAbilityStatus);
      socket.off('detective_check_result', onDetectiveCheckResult);
      socket.off('officer_ability_status', onOfficerAbilityStatus);
      socket.off('officer_lock_result', onOfficerLockResult);
      socket.off('game_over', onGameOver);
    };
  }, []); // Empty dependency array — listeners are set up exactly once.

  useEffect(() => {
    const recoverFromBackground = () => {
      if (document.hidden) return;

      // Always ask the server first; this covers reconnects and clock skew.  The
      // local timestamp check below removes a frozen CSS blackout immediately
      // while the authoritative packet is in flight.
      if (gameRoomCodeRef.current) {
        socket.emit('request_phase_state', { code: gameRoomCodeRef.current });
      }

      const snapshot = phaseSyncRef.current;
      if (!snapshot) return;
      const elapsed = now() - snapshot.phaseStartTime;
      const transitionElapsed = snapshot.phase === 'TRIAL_ANNOUNCEMENT'
        ? elapsed + 1500
        : elapsed;

      if (['TRANSITION_TO_TRIAL', 'TRIAL_ANNOUNCEMENT'].includes(snapshot.phase) && transitionElapsed >= 3500) {
        // The server's 1.5 s blackout + 2 s announcement already elapsed while
        // rendering was suspended. Reveal the interactive layout now; the phase
        // response will populate its exact current trial state immediately after.
        setGameData(prev => ({ ...prev, phase: 'trial' }));
        setDisplayPhase('trial');
        setCinematic(null);
      } else if (snapshot.phase === 'TRIAL_VOTING') {
        setGameData(prev => ({ ...prev, phase: 'trial' }));
        setDisplayPhase('trial');
        setCinematic(null);
      } else if (snapshot.phase === 'EXPLORATION') {
        setGameData(prev => ({ ...prev, phase: 'action' }));
        setDisplayPhase('action');
        setCinematic(null);
      }
    };

    document.addEventListener('visibilitychange', recoverFromBackground);
    return () => document.removeEventListener('visibilitychange', recoverFromBackground);
  }, []);

  // Request the authoritative micro-phase after mounting/reconnecting. This is
  // also the recovery path for clients that missed a broadcast while rendering.
  useEffect(() => {
    if (!gameRoomCodeRef.current) return;
    socket.emit('request_phase_state', { code: gameRoomCodeRef.current });
    if (gameData.phase === 'trial') socket.emit('request_trial_players', { code: gameRoomCodeRef.current });
  }, [gameData.phase]);

  const handleNicknameSubmit = (e) => {
    e.preventDefault();
    if (nickname.trim().length >= 2) {
      setIsNicknameSet(true);
      setTimeout(() => {
        setShowMainContent(true);
      }, 100);
    } else {
      alert(language === 'ru' ? 'Никнейм должен содержать не менее 2 символов.' : language === 'uk' ? "Нікнейм має містити щонайменше 2 символи." : language === 'es' ? 'El apodo debe tener al menos 2 caracteres.' : language === 'de' ? 'Der Spitzname muss mindestens 2 Zeichen lang sein.' : language === 'fr' ? 'Le pseudo doit comporter au moins 2 caractères.' : 'Nickname must be at least 2 characters long.');
    }
  };

  const openServersList = () => {
    socket.emit('get_public_rooms');
    setCurrentScreen('servers_list');
  };

  const handleCreateRoom = (type) => {
    socket.emit('create_room', { type, nickname });
  };

  const handleJoinByCode = (e) => {
    e.preventDefault();
    if (inputCode.length === 8) {
      socket.emit('join_by_code', { code: inputCode, nickname });
    } else {
      setErrorMessage(language === 'ru' ? 'Код должен состоять ровно из 8 символов.' : language === 'uk' ? "Код має складатися рівно з 8 символів." : language === 'es' ? 'El código debe tener exactamente 8 caracteres.' : language === 'de' ? 'Der Code muss genau 8 Zeichen lang sein.' : language === 'fr' ? 'Le code doit comporter exactement 8 caractères.' : 'Code must be exactly 8 characters.');
    }
  };

  const handleLeaveLobby = () => {
    if (activeRoom) {
      socket.emit('leave_room', { code: activeRoom.roomCode });
    }
    setActiveRoom(null);
    // Fully leaving the game/lobby — safe to clear the room code here
    gameRoomCodeRef.current = null;
    setCurrentScreen('main');
    setCountdown(null);
    setIsGameStarting(false);
    setFadeOpacity(0);
  };

  const myPlayerEntry = (displayPhase === 'trial' ? trialPlayers : activeRoom?.players || []).find(p => p.id === socket.id) || null;
  const isEliminated = Boolean(myPlayerEntry?.isEliminated);
  const isObserver = Boolean(myPlayerEntry?.isObserver);
  // True for the WHOLE round (not just this player's own turn) whenever the
  // Officer has confined them to the Holding Cell — see 'round_start' /
  // 'phase_state's lockedInHoldingCell. Drives a dedicated, persistent cell
  // view rendered below that completely replaces the normal turn/map UI,
  // regardless of whose turn is actually active.
  const isLockedInHoldingCell = Boolean(lockedInHoldingCell && lockedInHoldingCell.id === socket.id);
  const canObserveMap = displayPhase === 'action' && !isLockedInHoldingCell && (currentTurnPlayerId === socket.id || isObserver || isEliminated);

  const selectCharacter = (charName) => {
    if (isCharacterMenuConfirmed || isReady) return;

    const isTaken = activeRoom?.players.some(p => p.id !== socket.id && p.character === charName);
    if (isTaken) return;

    setSelectedChar(charName);
    socket.emit('select_character', { code: activeRoom.roomCode, character: charName });
  };

  const handleReadySubmit = () => {
    if (!selectedChar) return;
    const nextReadyState = !isReady;

    setIsReady(nextReadyState);
    setIsCharacterMenuConfirmed(nextReadyState);

    console.log('CLIENT emitting toggle_ready:', { code: activeRoom.roomCode, isReady: nextReadyState, character: selectedChar });

    socket.emit('toggle_ready', {
      code: activeRoom.roomCode,
      isReady: nextReadyState,
      character: selectedChar,
    });
  };

  // Host starts the preparation phase: joining is locked, players get a READY toggle
  const handleStartPreparation = () => {
    if (!activeRoom) return;
    socket.emit('start_preparation', { code: activeRoom.roomCode });
  };

  // Player leaves the room they just inspected, ending their turn right away
  // instead of waiting out the automatic countdown.
  const handleEndTurn = () => {
    if (currentTurnPlayerId !== socket.id || !gameRoomCodeRef.current) return;
    clearAutoEndCountdown();
    socket.emit('end_turn', { code: gameRoomCodeRef.current });
  };

  // Player investigates the room they've just entered, looking for a piece of
  // the digital code. Only makes sense once a room has actually been chosen,
  // and shares this turn's single room-interaction phase with "SEARCH FOR
  // BODY" below — whichever fires first locks out the other until a fresh
  // room is entered (see onRoomEntered) or a new turn starts (onTurnStart).
  const handleInvestigateRoom = () => {
    if (!gameRoomCodeRef.current || !revealedRoom || roomActionTaken) return;
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде действия недоступны.' : language === 'uk' ? "Ви ще приходите до тями після пастки — у цьому раунді дії недоступні." : language === 'es' ? 'Todavía te estás recuperando de la trampa — no hay acciones disponibles esta ronda.' : language === 'de' ? 'Du erholst dich noch von der Falle — in dieser Runde stehen keine Aktionen zur Verfügung.' : language === 'fr' ? "Vous vous remettez encore du piège — aucune action ce round." : "You're still recovering from the trap — no actions this round."); return; }
    setRoomActionTaken(true);
    setInvestigateUsedThisTurn(true);
    playAbilityUseSound(0.75);
    socket.emit('investigate_room', { code: gameRoomCodeRef.current, roomId: revealedRoom.roomId });
  };

  // Player checks the room they've just entered for a body — anyone executed
  // by a previous council vote while standing here. Mutually exclusive with
  // "INVESTIGATE ROOM" — see handleInvestigateRoom above.
  const handleSearchBody = () => {
    if (!gameRoomCodeRef.current || !revealedRoom || roomActionTaken) return;
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде действия недоступны.' : language === 'uk' ? "Ви ще приходите до тями після пастки — у цьому раунді дії недоступні." : language === 'es' ? 'Todavía te estás recuperando de la trampa — no hay acciones disponibles esta ronda.' : language === 'de' ? 'Du erholst dich noch von der Falle — in dieser Runde stehen keine Aktionen zur Verfügung.' : language === 'fr' ? "Vous vous remettez encore du piège — aucune action ce round." : "You're still recovering from the trap — no actions this round."); return; }
    setRoomActionTaken(true);
    playAbilityUseSound(0.75);
    socket.emit('search_body', { code: gameRoomCodeRef.current, roomId: revealedRoom.roomId });
  };

  // NOTE: Neurotoxin-7 pickup used to be a separate action via 'item:interact',
  // but the backend now folds it entirely into 'investigate_room' (see
  // handleInvestigateRoom above and onInvestigateResult's `neurotoxin`
  // handling) — that standalone handler was removed as dead code.

  // Innocent-only: "CHECK ROOM" (Mark Room). A SEPARATE ability from
  // INVESTIGATE ROOM/SEARCH FOR BODY above — not gated on roomActionTaken, so
  // it can still be used after SEARCH FOR BODY in the same turn. It DOES,
  // however, require INVESTIGATE ROOM to have already been used on this exact
  // room first (investigateUsedThisTurn, mirrored authoritatively server-side)
  // — Check Room logs/shares a room you've already investigated, it isn't a
  // free substitute for investigating it. Also gated on its own 2-round
  // cooldown (markRoomStatus, kept authoritative server-side) and on the room
  // not already being known-clear, since re-checking a room the team already
  // confirmed empty would just waste the cooldown for nothing.
  const handleCheckRoom = () => {
    if (myRole !== 'Innocent' || !gameRoomCodeRef.current || !revealedRoom || checkRoomSubmitting) return;
    if (!investigateUsedThisTurn) { pushToast(language === 'ru' ? 'Сначала обыщите эту комнату.' : language === 'uk' ? "Спочатку обшукайте цю кімнату." : language === 'es' ? 'Registra esta sala primero.' : language === 'de' ? 'Durchsuche zuerst diesen Raum.' : language === 'fr' ? "Enquêtez d'abord sur cette pièce." : 'Investigate this room first.'); return; }
    if (markRoomStatus && markRoomStatus.available === false) return;
    if (clearedRoomIds[revealedRoom.roomId]) return;
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : language === 'uk' ? "Ви ще приходите до тями після пастки — у цьому раунді здібності недоступні." : language === 'es' ? 'Todavía te estás recuperando de la trampa — no hay habilidades disponibles esta ronda.' : language === 'de' ? 'Du erholst dich noch von der Falle — in dieser Runde stehen keine Fähigkeiten zur Verfügung.' : language === 'fr' ? "Vous vous remettez encore du piège — aucune capacité ce round." : "You're still recovering from the trap — no abilities this round."); return; }
    setCheckRoomSubmitting(true);
    playAbilityUseSound(0.75);
    socket.emit('check_room', { code: gameRoomCodeRef.current, roomId: revealedRoom.roomId });
  };

  // Detective-only, Court/Trial phase only: requests the room a target player
  // ended their previous turn in. Gated client-side on the same cooldown flag
  // the server keeps authoritative (detectiveAbilityStatus); the server has
  // the final say and simply won't answer if it disagrees.
  const handleDetectiveCheck = (targetId) => {
    if (myRole !== 'Detective' || !gameRoomCodeRef.current) return;
    if (detectiveAbilityStatus && detectiveAbilityStatus.available === false) return;
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : language === 'uk' ? "Ви ще приходите до тями після пастки — у цьому раунді здібності недоступні." : language === 'es' ? 'Todavía te estás recuperando de la trampa — no hay habilidades disponibles esta ronda.' : language === 'de' ? 'Du erholst dich noch von der Falle — in dieser Runde stehen keine Fähigkeiten zur Verfügung.' : language === 'fr' ? "Vous vous remettez encore du piège — aucune capacité ce round." : "You're still recovering from the trap — no abilities this round."); return; }
    playAbilityUseSound(0.75);
    socket.emit('detective_check_location', { code: gameRoomCodeRef.current, targetId });
  };

  // Officer-only, Court/Trial phase only: locks a target player (including
  // the Officer themself) into the Holding Cell for the entire NEXT round.
  // Gated client-side on the same cooldown flag the server keeps
  // authoritative (officerAbilityStatus); the server has the final say.
  const handleOfficerLock = (targetId) => {
    if (myRole !== 'Officer' || !gameRoomCodeRef.current) return;
    if (officerAbilityStatus && officerAbilityStatus.available === false) return;
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : language === 'uk' ? "Ви ще приходите до тями після пастки — у цьому раунді здібності недоступні." : language === 'es' ? 'Todavía te estás recuperando de la trampa — no hay habilidades disponibles esta ronda.' : language === 'de' ? 'Du erholst dich noch von der Falle — in dieser Runde stehen keine Fähigkeiten zur Verfügung.' : language === 'fr' ? "Vous vous remettez encore du piège — aucune capacité ce round." : "You're still recovering from the trap — no abilities this round."); return; }
    playAbilityUseSound(0.75);
    socket.emit('officer_lock_player', { code: gameRoomCodeRef.current, targetId });
  };

  // Joker-only: opens the room-picker modal (button lives under the mansion
  // map, visible for the Joker's whole turn — no longer requires having
  // searched a room first). Gated client-side on the same cooldown flag the
  // server keeps authoritative (jokerEvidenceStatus); the modal itself does
  // the final per-room submit.
  const handleOpenJokerPlantPicker = () => {
    if (myRole !== 'Joker' || currentTurnPlayerId !== socket.id) return;
    if (jokerEvidenceStatus && jokerEvidenceStatus.available === false) return;
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : language === 'uk' ? "Ви ще приходите до тями після пастки — у цьому раунді здібності недоступні." : language === 'es' ? 'Todavía te estás recuperando de la trampa — no hay habilidades disponibles esta ronda.' : language === 'de' ? 'Du erholst dich noch von der Falle — in dieser Runde stehen keine Fähigkeiten zur Verfügung.' : language === 'fr' ? "Vous vous remettez encore du piège — aucune capacité ce round." : "You're still recovering from the trap — no abilities this round."); return; }
    playHoverSound(0.25);
    setJokerPlantFloor(mansionFloor);
    setJokerPlantPickerOpen(true);
  };

  // Fires once the Joker taps a room tile inside the picker modal. The modal
  // stays open with a small loading state on that tile until the server
  // confirms via 'joker_evidence_result' (see onJokerEvidenceResult), which
  // closes it — keeps the interaction feeling responsive instead of the modal
  // vanishing before we know whether the plant actually succeeded.
  const handleChooseJokerPlantRoom = (roomId) => {
    if (!gameRoomCodeRef.current || myRole !== 'Joker' || jokerPlantSubmittingRoomId) return;
    if (roomId === 'f1_holding_cell') return;
    if (jokerEvidenceStatus && jokerEvidenceStatus.available === false) return;
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : language === 'uk' ? "Ви ще приходите до тями після пастки — у цьому раунді здібності недоступні." : language === 'es' ? 'Todavía te estás recuperando de la trampa — no hay habilidades disponibles esta ronda.' : language === 'de' ? 'Du erholst dich noch von der Falle — in dieser Runde stehen keine Fähigkeiten zur Verfügung.' : language === 'fr' ? "Vous vous remettez encore du piège — aucune capacité ce round." : "You're still recovering from the trap — no abilities this round."); return; }
    playAbilityUseSound(0.75);
    setJokerPlantSubmittingRoomId(roomId);
    socket.emit('plant_joker_evidence', { code: gameRoomCodeRef.current, roomId });
  };

  // Accomplice-only: a SEPARATE ability from "INVESTIGATE ROOM" — the
  // Accomplice has no passive free reveal anymore, so they need to actually
  // investigate the room first (same as every other role) before there's any
  // real evidence here to alter. Opens the "CHANGE EVIDENCE" target-picker
  // modal for the specific piece of evidence the player tapped directly —
  // there's no standalone button anymore, tapping an evidence chip is the
  // only way in (see canChangeThis below). Gated client-side on the same
  // cooldown flag the server keeps authoritative (accompliceEvidenceStatus)
  // — the server has the final say either way.
  const handleOpenChangeEvidence = (evidenceId) => {
    if (myRole !== 'Accomplice' || !revealedRoom || !evidenceId) return;
    if (accompliceEvidenceStatus && accompliceEvidenceStatus.available === false) return;
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : language === 'uk' ? "Ви ще приходите до тями після пастки — у цьому раунді здібності недоступні." : language === 'es' ? 'Todavía te estás recuperando de la trampa — no hay habilidades disponibles esta ronda.' : language === 'de' ? 'Du erholst dich noch von der Falle — in dieser Runde stehen keine Fähigkeiten zur Verfügung.' : language === 'fr' ? "Vous vous remettez encore du piège — aucune capacité ce round." : "You're still recovering from the trap — no abilities this round."); return; }
    playHoverSound(0.25);
    setChangeEvidenceTargetEvidenceId(evidenceId);
    setChangeEvidencePickerOpen(true);
  };

  // Fires once the Accomplice taps a target player inside the "CHANGE
  // EVIDENCE" modal. The modal stays open with a small loading state on that
  // row until the server confirms via 'accomplice_evidence_result' (see
  // onAccompliceEvidenceResult), which closes it — same responsive-feeling
  // pattern as handleChooseJokerPlantRoom above. The Accomplice themselves is
  // never a valid target — enforced again here as a first line of defense on
  // top of the server's own check.
  const handleSubmitChangeEvidence = (targetPlayerId) => {
    if (!gameRoomCodeRef.current || myRole !== 'Accomplice' || !revealedRoom) return;
    if (!changeEvidenceTargetEvidenceId || changeEvidenceSubmittingTargetId) return;
    if (targetPlayerId === socket.id) return;
    if (accompliceEvidenceStatus && accompliceEvidenceStatus.available === false) return;
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : language === 'uk' ? "Ви ще приходите до тями після пастки — у цьому раунді здібності недоступні." : language === 'es' ? 'Todavía te estás recuperando de la trampa — no hay habilidades disponibles esta ronda.' : language === 'de' ? 'Du erholst dich noch von der Falle — in dieser Runde stehen keine Fähigkeiten zur Verfügung.' : language === 'fr' ? "Vous vous remettez encore du piège — aucune capacité ce round." : "You're still recovering from the trap — no abilities this round."); return; }
    playAbilityUseSound(0.75);
    setChangeEvidenceSubmittingTargetId(targetPlayerId);
    socket.emit('accomplice_change_evidence', {
      code: gameRoomCodeRef.current,
      roomId: revealedRoom.roomId,
      evidenceId: changeEvidenceTargetEvidenceId,
      targetPlayerId
    });
  };

  // Accomplice-only: opens the "SET A TRAP" room-picker modal (button lives
  // under the mansion map, visible for the Accomplice's whole turn — same
  // spot/pattern as the Joker's "PLANT EVIDENCE" button above). Gated
  // client-side on the same round-based cooldown flag the server keeps
  // authoritative (accompliceTrapStatus); the modal itself does the final
  // per-room submit.
  const handleOpenAccompliceTrapPicker = () => {
    if (myRole !== 'Accomplice' || currentTurnPlayerId !== socket.id) return;
    if (accompliceTrapStatus && accompliceTrapStatus.available === false) return;
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : language === 'uk' ? "Ви ще приходите до тями після пастки — у цьому раунді здібності недоступні." : language === 'es' ? 'Todavía te estás recuperando de la trampa — no hay habilidades disponibles esta ronda.' : language === 'de' ? 'Du erholst dich noch von der Falle — in dieser Runde stehen keine Fähigkeiten zur Verfügung.' : language === 'fr' ? "Vous vous remettez encore du piège — aucune capacité ce round." : "You're still recovering from the trap — no abilities this round."); return; }
    playHoverSound(0.25);
    setAccompliceTrapFloor(mansionFloor);
    setAccompliceTrapPickerOpen(true);
  };

  // Fires once the Accomplice taps a room tile inside the trap picker modal.
  // The modal stays open with a small loading state on that tile until the
  // server confirms via 'set_trap_result' (see onSetTrapResult), which closes
  // it — same responsive-feeling pattern as handleChooseJokerPlantRoom above.
  const handleChooseAccompliceTrapRoom = (roomId) => {
    if (!gameRoomCodeRef.current || myRole !== 'Accomplice' || accompliceTrapSubmittingRoomId) return;
    if (roomId === 'f1_holding_cell') return;
    if (accompliceTrapStatus && accompliceTrapStatus.available === false) return;
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : language === 'uk' ? "Ви ще приходите до тями після пастки — у цьому раунді здібності недоступні." : language === 'es' ? 'Todavía te estás recuperando de la trampa — no hay habilidades disponibles esta ronda.' : language === 'de' ? 'Du erholst dich noch von der Falle — in dieser Runde stehen keine Fähigkeiten zur Verfügung.' : language === 'fr' ? "Vous vous remettez encore du piège — aucune capacité ce round." : "You're still recovering from the trap — no abilities this round."); return; }
    playAbilityUseSound(0.75);
    setAccompliceTrapSubmittingRoomId(roomId);
    socket.emit('set_trap', { code: gameRoomCodeRef.current, roomId });
  };

  // Innocent-only: submit an attempt at the fully-assembled override code from
  // the trial terminal. The server is the sole judge of correctness — this
  // just forwards the draft digits and waits for 'code_submission_result' (on
  // failure) or 'game_over' (on success).
  const handleSubmitInnocentCode = () => {
    if (!gameRoomCodeRef.current || !codeGuess.trim()) return;
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — терминал не примет ввод в этом раунде.' : language === 'uk' ? "Ви ще приходите до тями після пастки — термінал не прийме введення в цьому раунді." : language === 'es' ? 'Todavía te estás recuperando de la trampa — el terminal no aceptará entradas esta ronda.' : language === 'de' ? 'Du erholst dich noch von der Falle — das Terminal akzeptiert diese Runde keine Eingaben.' : language === 'fr' ? "Vous vous remettez encore du piège — le terminal n'acceptera aucune saisie ce round." : "You're still recovering from the trap — the terminal won't accept input this round."); return; }
    socket.emit('submit_innocent_code', { code: gameRoomCodeRef.current, guess: codeGuess.trim() });
  };

  // Player selects a mansion room to search during their turn — exactly one attempt
  // per turn. This IS the turn's action: their character moves there, and the turn
  // will end automatically shortly after (see onRoomEntered / the server's shortened
  // per-turn timer).
  const handleSelectRoom = (roomId) => {
    const spectatorMode = isEliminated || isObserver;
    if ((roomId === 'f1_holding_cell' && !spectatorMode) || !gameRoomCodeRef.current) return;
    if (!spectatorMode && (roomChosen || currentTurnPlayerId !== socket.id)) return;
    socket.emit('select_room', { code: gameRoomCodeRef.current, roomId });
  };

  // Killer only: use the vent connecting the room they're currently standing
  // in (see VENTS) to instantly relocate to its paired destination. Only
  // meaningful once a room has already been searched this turn — mirrors the
  // server, which also requires an existing location to vent out of. Gated
  // client-side the same way handleSelectRoom is gated (role, whose turn it
  // is, spectator status, one use per turn); the server re-checks all of it
  // and is the real authority.
  const handleUseVent = () => {
    if (myRole !== 'Killer' || currentTurnPlayerId !== socket.id) return;
    if (isEliminated || isObserver) return;
    if (!gameRoomCodeRef.current || !revealedRoom || ventUsedThisTurn) return;
    if (!VENTS[revealedRoom.roomId]) return;
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : language === 'uk' ? "Ви ще приходите до тями після пастки — у цьому раунді здібності недоступні." : language === 'es' ? 'Todavía te estás recuperando de la trampa — no hay habilidades disponibles esta ronda.' : language === 'de' ? 'Du erholst dich noch von der Falle — in dieser Runde stehen keine Fähigkeiten zur Verfügung.' : language === 'fr' ? "Vous vous remettez encore du piège — aucune capacité ce round." : "You're still recovering from the trap — no abilities this round."); return; }
    setVentUsedThisTurn(true);
    playAbilityUseSound(0.75);
    socket.emit('use_vent', { code: gameRoomCodeRef.current });
  };

  // Killer only: clicking another live occupant's avatar in the room-peek
  // panel triggers the kill. Gated client-side the same way every other turn
  // action is (role, whose turn it is, spectator status, and never while a
  // previous kill's body decision is still pending) — the server re-checks
  // every bit of this and is the real authority. The post-kill modal itself
  // opens once 'kill_options' comes back (see onKillOptions), not optimistically
  // here, since only the server knows whether a vent escape is actually on offer.
  const handleKillPlayer = (targetId) => {
    if (myRole !== 'Killer' || currentTurnPlayerId !== socket.id) return;
    if (isEliminated || isObserver) return;
    if (!gameRoomCodeRef.current || !revealedRoom || pendingKillDecision) return;
    if (!targetId || targetId === socket.id) return;
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : language === 'uk' ? "Ви ще приходите до тями після пастки — у цьому раунді здібності недоступні." : language === 'es' ? 'Todavía te estás recuperando de la trampa — no hay habilidades disponibles esta ronda.' : language === 'de' ? 'Du erholst dich noch von der Falle — in dieser Runde stehen keine Fähigkeiten zur Verfügung.' : language === 'fr' ? "Vous vous remettez encore du piège — aucune capacité ce round." : "You're still recovering from the trap — no abilities this round."); return; }
    socket.emit('kill_player', { code: gameRoomCodeRef.current, targetId });
  };

  // Killer only: resolves the mandatory post-kill decision — 'hide' or
  // 'expose'. The modal stays open with a small loading state until the
  // server confirms via 'kill_resolved' (see onKillResolved), same pattern as
  // the Joker's evidence-planting picker.
  const handleResolveKill = (action) => {
    if (!gameRoomCodeRef.current || !pendingKillDecision || resolvingKill) return;
    if (!['hide', 'expose'].includes(action)) return;
    setResolvingKill(true);
    playAbilityUseSound(0.75);
    socket.emit('resolve_kill', { code: gameRoomCodeRef.current, action });
  };

  const getTakenCharacters = () => {
    if (!activeRoom) return [];
    return activeRoom.players
      .filter(p => p.id !== socket.id && p.character)
      .map(p => p.character);
  };

  const isHost = !!activeRoom && activeRoom.hostId === socket.id;
  const isPreparing = activeRoom?.status === 'preparing';
  const lobbyPlayerCount = activeRoom?.players?.length ?? 0;
  const canStartPreparation = lobbyPlayerCount >= MIN_PLAYERS && lobbyPlayerCount <= MAX_PLAYERS;
  const rolePoolPreview = getRolePoolPreview(lobbyPlayerCount);
  const activeRoleData = myRole ? ROLES[myRole] : null;

  return (
    <div style={{
      margin: 0,
      padding: '20px',
      boxSizing: 'border-box',
      background: 'radial-gradient(circle at center, #11111a 0%, #050508 100%)',
      color: '#e2e8f0',
      minHeight: `${viewportHeight}px`,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      // In the lobby and tutorial (dossier) screens, content is often taller
      // than the viewport — align to top and allow scrolling, otherwise
      // vertical centering clips the bottom of the card (e.g. the tutorial's
      // BACK button becomes unreachable on phones).
      justifyContent: (currentScreen === 'lobby' || currentScreen === 'tutorial') ? 'flex-start' : 'center',
      overflowY: 'auto',
      WebkitOverflowScrolling: 'touch',
    }}>

      {!isNicknameSet && (
        <div style={{
          padding: '35px 40px',
          width: '100%',
          maxWidth: '440px',
          textAlign: 'center',
          background: 'rgba(18, 18, 28, 0.75)',
          backdropFilter: 'blur(16px)',
          borderRadius: '16px',
          border: '1px solid rgba(255, 255, 255, 0.07)',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.5)'
        }}>
          <h1 style={{ fontSize: '32px', letterSpacing: '4px', marginBottom: '20px', fontFamily: 'Georgia, serif', fontStyle: 'italic' }}>{t('enterNickname')}</h1>
          <form onSubmit={handleNicknameSubmit}>
            <input
              type="text"
              placeholder={t('nicknamePlaceholder')}
              maxLength={15}
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              style={{
                width: '100%',
                padding: '14px',
                marginBottom: '20px',
                borderRadius: '8px',
                border: '1px solid #00f0ff',
                backgroundColor: 'rgba(0, 0, 0, 0.4)',
                color: '#fff',
                fontSize: '16px',
                letterSpacing: '2px',
                textAlign: 'center',
                outline: 'none',
                boxSizing: 'border-box'
              }}
            />
            <NeonButton type="submit" variant="success">{t('initializeTerminal')}</NeonButton>
          </form>
        </div>
      )}

      {isNicknameSet && currentScreen !== 'game' && (
        <div style={{
          opacity: showMainContent ? 1 : 0,
          transition: 'opacity 0.8s ease-in-out',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          paddingBottom: (currentScreen === 'lobby' || currentScreen === 'tutorial') ? '30px' : '0px'
        }}>
          {/* HEADER */}
          <header style={{ marginBottom: '30px', textAlign: 'center', zIndex: 1, flexShrink: 0 }}>
            <h1 style={{
              fontSize: '42px',
              fontWeight: '900',
              letterSpacing: '6px',
              margin: '0 0 8px 0',
              color: '#ffffff',
              textShadow: '0 0 20px rgba(255,255,255,0.15), 2px 2px 0px #ff2a5f',
              fontFamily: 'Georgia, serif',
              fontStyle: 'italic'
            }}>
              TWELVE SUSPECTS
            </h1>
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              background: 'rgba(0,0,0,0.4)',
              padding: '6px 14px',
              borderRadius: '20px',
              border: '1px solid rgba(255,255,255,0.05)'
            }}>
              <span style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor: isConnected ? '#00ff87' : '#ff2a5f',
                boxShadow: isConnected ? '0 0 8px #00ff87' : '0 0 8px #ff2a5f'
              }} />
              <span style={{ fontSize: '11px', letterSpacing: '1px', color: '#8a99ad', fontWeight: 'bold', textTransform: 'uppercase' }}>
                AGENT: {nickname.toUpperCase()} | SYSTEM: {isConnected ? 'ONLINE' : 'OFFLINE'}
              </span>
            </div>
          </header>

          {/* MAIN CARD */}
          <main style={{
            padding: '35px 40px',
            width: '100%',
            maxWidth: currentScreen === 'lobby' ? '920px' : '440px',
            maxHeight: currentScreen === 'lobby' ? `${Math.round(viewportHeight * 0.82)}px` : currentScreen === 'tutorial' ? `min(600px, ${viewportHeight - 140}px)` : 'none',
            overflowY: currentScreen === 'lobby' ? 'auto' : 'visible',
            display: currentScreen === 'tutorial' ? 'flex' : 'block',
            flexDirection: 'column',
            WebkitOverflowScrolling: 'touch',
            overscrollBehavior: 'contain',
            textAlign: 'center',
            zIndex: 1,
            background: 'rgba(18, 18, 28, 0.75)',
            backdropFilter: 'blur(16px)',
            borderRadius: '16px',
            border: '1px solid rgba(255, 255, 255, 0.07)',
            boxShadow: '0 20px 50px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255,255,255,0.1)',
            boxSizing: 'border-box',
            transition: 'max-width 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
          }}>

            {/* --- SCREEN 1: MAIN MENU --- */}
            {currentScreen === 'main' && (
              <div style={{ display: 'flex', flexDirection: 'column', padding: '10px 0' }}>
                <NeonButton variant="primary" onClick={() => setCurrentScreen('play_menu')}>{t('launchCase')}</NeonButton>
                <NeonButton variant="secondary" onClick={() => setCurrentScreen('settings')}>{t('settings')}</NeonButton>
                <NeonButton variant="secondary" onClick={() => setCurrentScreen('tutorial')}>{t('dossierRules')}</NeonButton>
              </div>
            )}

            {/* --- SCREEN 2: GAME MODES --- */}
            {currentScreen === 'play_menu' && (
              <div>
                <h3 style={{ marginBottom: '25px', color: '#8a99ad', fontSize: '14px', letterSpacing: '2px', textTransform: 'uppercase' }}>{t('selectOperation')}</h3>
                <NeonButton variant="primary" onClick={openServersList}>{t('publicLobbies')}</NeonButton>
                <NeonButton variant="primary" onClick={() => { setCurrentScreen('connect_code'); setErrorMessage(''); setInputCode(''); }}>{t('secureConnection')}</NeonButton>
                <NeonButton variant="success" onClick={() => setCurrentScreen('create_server')}>{t('establishHQ')}</NeonButton>
                <NeonButton variant="secondary" style={{ marginTop: '10px' }} onClick={() => setCurrentScreen('main')}><Icon name="arrowLeft" size={13} style={{ marginRight: 6 }} />{t('return')}</NeonButton>
              </div>
            )}

            {/* --- SERVERS LIST --- */}
            {currentScreen === 'servers_list' && (
              <div>
                <h3 style={{ marginBottom: '20px', letterSpacing: '2px', fontSize: '15px' }}>{t('availableChannels')}</h3>
                {errorMessage && <p style={{ color: '#ff2a5f', fontSize: '13px', margin: '0 0 15px 0', letterSpacing: '1px', display: 'flex', alignItems: 'center', gap: '6px' }}><Icon name="alert" size={13} />{errorMessage}</p>}
                <div style={{
                  maxHeight: '280px',
                  overflowY: 'auto',
                  marginBottom: '20px',
                  borderRadius: '8px',
                  background: 'rgba(0,0,0,0.2)'
                }}>
                  {publicRooms.length === 0 ? (
                    <p style={{ color: '#6272a4', padding: '30px', fontSize: '13px', fontStyle: 'italic' }}>{t('scanningFrequencies')}</p>
                  ) : (
                    publicRooms.map((room) => (
                      <div key={room.id} style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '14px 16px',
                        borderBottom: '1px solid rgba(255,255,255,0.04)',
                        textAlign: 'left'
                      }}>
                        <div style={{ flex: 1, marginRight: '10px' }}>
                          <div style={{ fontWeight: 'bold', color: '#fff', fontSize: '14px', marginBottom: '2px' }}>{room.name}</div>
                          <div style={{ fontSize: '11px', color: '#00f0ff', letterSpacing: '1px' }}>{t('idLabel')} {room.code}</div>
                        </div>
                        <span style={{ color: '#8a99ad', fontSize: '13px', marginRight: '15px', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '5px' }}><Icon name="users" size={13} />{room.playersCount}/{room.maxPlayers || MAX_PLAYERS}</span>
                        <button style={{
                          background: '#00f0ff',
                          color: '#000',
                          border: 'none',
                          padding: '6px 14px',
                          borderRadius: '4px',
                          fontSize: '11px',
                          fontWeight: '900',
                          letterSpacing: '1px',
                          cursor: 'pointer'
                        }} onClick={() => socket.emit('join_by_code', { code: room.code, nickname })}>{t('join')}</button>
                      </div>
                    ))
                  )}
                </div>
                <NeonButton variant="secondary" onClick={() => setCurrentScreen('play_menu')}><Icon name="arrowLeft" size={13} style={{ marginRight: 6 }} />{t('back')}</NeonButton>
              </div>
            )}

            {/* --- JOIN BY CODE --- */}
            {currentScreen === 'connect_code' && (
              <form onSubmit={handleJoinByCode}>
                <h3 style={{ marginBottom: '20px', letterSpacing: '2px', fontSize: '15px' }}>{t('enterDecryptionKey')}</h3>
                <input
                  type="text"
                  placeholder={t('hexCodePlaceholder')}
                  maxLength={8}
                  value={inputCode}
                  onChange={(e) => setInputCode(e.target.value.toUpperCase())}
                  style={{
                    width: '100%',
                    padding: '14px',
                    marginBottom: '15px',
                    borderRadius: '8px',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    backgroundColor: 'rgba(0, 0, 0, 0.3)',
                    color: '#00f0ff',
                    fontSize: '18px',
                    letterSpacing: '4px',
                    textAlign: 'center',
                    boxSizing: 'border-box',
                    outline: 'none',
                    fontFamily: 'monospace'
                  }}
                />
                {errorMessage && <p style={{ color: '#ff2a5f', fontSize: '13px', margin: '0 0 15px 0', letterSpacing: '1px', display: 'flex', alignItems: 'center', gap: '6px' }}><Icon name="alert" size={13} />{errorMessage}</p>}
                <button type="submit" style={{ display: 'none' }} />
                <NeonButton onClick={handleJoinByCode} variant="primary">{t('establishLink')}</NeonButton>
                <NeonButton variant="secondary" onClick={() => setCurrentScreen('play_menu')}><Icon name="arrowLeft" size={13} style={{ marginRight: 6 }} />{t('back')}</NeonButton>
              </form>
            )}

            {/* --- CREATE SERVER --- */}
            {currentScreen === 'create_server' && (
              <div>
                <h3 style={{ marginBottom: '25px', letterSpacing: '2px', fontSize: '15px' }}>{t('hqConfiguration')}</h3>

                <div style={{ marginBottom: '20px', textAlign: 'left', background: 'rgba(255,255,255,0.02)', padding: '15px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <NeonButton variant="success" onClick={() => handleCreateRoom('public')} style={{ marginBottom: '8px' }}>{t('publicBroadcast')}</NeonButton>
                  <p style={{ fontSize: '11px', color: '#8a99ad', margin: 0, paddingLeft: '5px' }}>{t('publicBroadcastDesc')}</p>
                </div>

                <div style={{ marginBottom: '25px', textAlign: 'left', background: 'rgba(255,255,255,0.02)', padding: '15px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <NeonButton variant="danger" onClick={() => handleCreateRoom('private')} style={{ marginBottom: '8px' }}>{t('covertChannel')}</NeonButton>
                  <p style={{ fontSize: '11px', color: '#8a99ad', margin: 0, paddingLeft: '5px' }}>{t('covertChannelDesc')}</p>
                </div>

                <NeonButton variant="secondary" onClick={() => setCurrentScreen('play_menu')}><Icon name="arrowLeft" size={13} style={{ marginRight: 6 }} />{t('back')}</NeonButton>
              </div>
            )}

            {/* --- GAME LOBBY --- */}
            {currentScreen === 'lobby' && activeRoom && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px', flexWrap: 'wrap', gap: '10px' }}>
                  <div style={{ textAlign: 'left' }}>
                    <span style={{ fontSize: '10px', color: '#00ff87', letterSpacing: '2px', fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', gap: '5px' }}><Icon name="mapPin" size={12} />{t('hqBase')}</span>
                    <h2 style={{ color: '#fff', margin: '2px 0', fontSize: '20px' }}>{activeRoom.roomName}</h2>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                    <span style={{
                      fontSize: '10px',
                      fontWeight: 'bold',
                      letterSpacing: '1px',
                      padding: '6px 12px',
                      borderRadius: '6px',
                      color: isPreparing ? '#ff9100' : '#00ff87',
                      border: isPreparing ? '1px solid #ff9100' : '1px solid #00ff87',
                      background: isPreparing ? 'rgba(255,145,0,0.08)' : 'rgba(0,255,135,0.08)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px'
                    }}>
                      <Icon name={isPreparing ? 'lock' : 'unlock'} size={12} /> {isPreparing ? t('preparing') : t('open')}
                    </span>
                    <div style={{ background: 'rgba(0,0,0,0.3)', padding: '8px 16px', borderRadius: '6px', border: '1px solid #00f0ff' }}>
                      <span style={{ fontSize: '11px', color: '#8a99ad' }}>{t('linkCode')} </span>
                      <strong style={{ fontFamily: 'monospace', color: '#00f0ff', fontSize: '16px', letterSpacing: '2px' }}>{activeRoom.roomCode}</strong>
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '25px', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'flex-start' }}>

                  {/* Character grid */}
                  <div style={{ flex: '2 1 500px', paddingBottom: '10px' }}>
                    <h4 style={{ textAlign: 'left', margin: '0 0 15px 0', letterSpacing: '2px', color: '#8a99ad', fontSize: '12px' }}>{t('selectProfile')}</h4>
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: isMobile ? 'repeat(3, 1fr)' : 'repeat(4, 1fr)',
                      gap: isMobile ? '8px' : '10px',
                      marginBottom: '20px'
                    }}>
                      {CHARACTERS.map((char) => {
                        const isTaken = getTakenCharacters().includes(char.name);
                        const isSelectedByMe = selectedChar === char.name;

                        return (
                          <div
                            key={char.name}
                            onClick={() => selectCharacter(char.name)}
                            style={{
                              position: 'relative',
                              borderRadius: '8px',
                              overflow: 'hidden',
                              border: isSelectedByMe ? '2px solid #00ff87' : (isTaken ? '1px solid #ff2a5f' : '1px solid rgba(255,255,255,0.15)'),
                              cursor: (isTaken || isCharacterMenuConfirmed || isReady) ? 'not-allowed' : 'pointer',
                              backgroundColor: 'rgba(0,0,0,0.4)',
                              boxShadow: isSelectedByMe ? '0 0 15px rgba(0, 255, 135, 0.4)' : 'none',
                              opacity: isTaken ? 0.3 : 1,
                              transition: 'all 0.2s ease'
                            }}
                          >
                            <img
                              src={char.url}
                              alt={char.name}
                              style={{ width: '100%', height: isMobile ? '120px' : '170px', objectFit: 'cover', display: 'block' }}
                            />
                            <div style={{
                              padding: '6px 2px',
                              fontSize: '11px',
                              fontWeight: 'bold',
                              color: isSelectedByMe ? '#00ff87' : '#fff',
                              background: 'rgba(0,0,0,0.6)',
                              letterSpacing: '1px'
                            }}>
                              {char.name.toUpperCase()}
                            </div>

                            {isTaken && (
                              <div style={{ position: 'absolute', top: 5, right: 5, background: '#ff2a5f', color: '#000', fontSize: '8px', padding: '2px 4px', borderRadius: '3px', fontWeight: 'bold' }}>
                                {t('taken')}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {isPreparing ? (
                      // Preparation phase already started (host clicked start) — can click READY
                      <NeonButton
                        variant={isReady ? "danger" : "success"}
                        disabled={!selectedChar}
                        onClick={handleReadySubmit}
                      >
                        {isReady ? t('cancelReady') : t('confirmIdentity')}
                      </NeonButton>
                    ) : isHost ? (
                      // Room still open — only the host sees the start button
                      <NeonButton
                        variant="primary"
                        disabled={!canStartPreparation}
                        onClick={handleStartPreparation}
                      >
                        {canStartPreparation ? t('startOperation') : t('waitingForAgents', activeRoom.players.length, MIN_PLAYERS)}
                      </NeonButton>
                    ) : (
                      // Regular player waits for the host to launch preparation
                      <p style={{ fontSize: '12px', color: '#8a99ad', textAlign: 'center', letterSpacing: '1px', margin: '10px 0 0 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                        <Icon name="hourglass" size={13} /> {t('waitingForHost')}
                      </p>
                    )}
                  </div>

                  {/* Sidebar */}
                  <div style={{ flex: '1 1 240px', background: 'rgba(0,0,0,0.2)', padding: '15px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.05)', textAlign: 'left' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                      <h4 style={{ margin: 0, letterSpacing: '1px', fontSize: '12px', color: '#8a99ad' }}>{t('connectedChannels')}</h4>
                      <span style={{
                        fontSize: '12px',
                        fontWeight: 'bold',
                        fontFamily: 'monospace',
                        letterSpacing: '1px',
                        padding: '3px 8px',
                        borderRadius: '4px',
                        color: canStartPreparation ? '#00ff87' : '#ff2a5f',
                        border: canStartPreparation ? '1px solid #00ff87' : '1px solid #ff2a5f',
                        background: canStartPreparation ? 'rgba(0,255,135,0.08)' : 'rgba(255,42,95,0.08)'
                      }}>
                        {activeRoom.players.length} / {MAX_PLAYERS}
                      </span>
                    </div>
                    {lobbyPlayerCount < MIN_PLAYERS && (
                      <p style={{ fontSize: '11px', color: '#ff9100', margin: '-10px 0 15px 0', letterSpacing: '0.5px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <Icon name="alert" size={12} /> {t('requiresPlayers')}
                      </p>
                    )}
                    <div style={{ marginBottom: '15px', padding: '10px', borderRadius: '6px', background: 'rgba(0,240,255,0.04)', border: '1px solid rgba(0,240,255,0.18)' }}>
                      <div style={{ fontSize: '10px', color: '#8a99ad', fontWeight: 'bold', letterSpacing: '1px', marginBottom: '7px' }}>
                        {t('activeRolePool')} {lobbyPlayerCount > 7 ? t('fullTag') : t('baseTag')}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                        {rolePoolPreview.map(({ name, count }) => (
                          <span key={name} style={{ fontSize: '10px', padding: '3px 6px', borderRadius: '4px', color: ROLES[name].color, border: `1px solid ${ROLES[name].color}`, background: 'rgba(0,0,0,0.25)' }}>
                            {language === 'ru' ? ROLES[name].labelRu : language === 'uk' ? ROLES[name].labelUk : language === 'es' ? ROLES[name].labelEs : language === 'de' ? ROLES[name].labelDe : language === 'fr' ? ROLES[name].labelFr : ROLES[name].label}{count > 1 ? ` ×${count}` : ''}
                          </span>
                        ))}
                      </div>
                      <div style={{ fontSize: '10px', color: '#8a99ad', marginTop: '7px' }}>
                        {lobbyPlayerCount > 7 ? t('allRolesUnlocked') : t('rolesUnlockAt7')}
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      {activeRoom.players.map((player) => (
                        <div key={player.id} style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          background: player.id === socket.id ? 'rgba(0,240,255,0.05)' : 'rgba(255,255,255,0.02)',
                          padding: '10px',
                          borderRadius: '6px',
                          border: player.id === socket.id ? '1px solid rgba(0,240,255,0.3)' : '1px solid transparent'
                        }}>
                          <div>
                            <div style={{ fontWeight: 'bold', fontSize: '13px', color: '#fff' }}>
                              {player.nickname} {player.id === socket.id && <span style={{ color: '#00f0ff', fontSize: '10px' }}>{t('youTag')}</span>}
                              {player.id === activeRoom.hostId && <span style={{ color: '#ffd700', fontSize: '10px', marginLeft: '4px', display: 'inline-flex', alignItems: 'center', gap: '3px' }}><Icon name="crown" size={11} />{t('hostTag')}</span>}
                            </div>
                            <div style={{ fontSize: '11px', color: player.character ? '#00ff87' : '#8a99ad', marginTop: '2px' }}>
                              {t('profileLabel')} {player.character ? player.character : t('selectingEllipsis')}
                            </div>
                          </div>
                          <span style={{
                            fontSize: '10px',
                            fontWeight: 'bold',
                            color: player.isReady ? '#00ff87' : '#ff2a5f',
                            background: player.isReady ? 'rgba(0,255,135,0.1)' : 'rgba(255,42,95,0.1)',
                            padding: '3px 8px',
                            borderRadius: '4px',
                            border: player.isReady ? '1px solid #00ff87' : '1px solid #ff2a5f',
                            transition: 'all 0.2s ease'
                          }}>
                            {player.isReady ? t('ready') : t('wait')}
                          </span>
                        </div>
                      ))}
                    </div>

                    <div style={{ marginTop: '20px' }}>
                      <NeonButton variant="secondary" onClick={handleLeaveLobby} style={{ padding: '10px', fontSize: '12px' }}>{t('disconnect')}</NeonButton>
                    </div>
                  </div>

                </div>

              </div>
            )}

            {/* --- SCREEN: SETTINGS --- */}
            {currentScreen === 'settings' && (
              <div>
                <h3 style={{ marginBottom: '25px', letterSpacing: '2px', fontSize: '15px' }}>{t('terminalAdjustments')}</h3>
                <div style={{
                  padding: '20px 15px',
                  background: 'rgba(0,0,0,0.2)',
                  borderRadius: '8px',
                  border: '1px solid rgba(255,255,255,0.05)',
                  marginBottom: '25px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '20px'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '13px', fontWeight: 'bold', letterSpacing: '1px', color: '#bdc7db' }}>{t('hqAmbientMusic')}</span>
                    <button
                      onClick={toggleMusic}
                      style={{
                        background: isMusicPlaying ? 'rgba(0, 255, 135, 0.1)' : 'rgba(255, 42, 95, 0.1)',
                        border: isMusicPlaying ? '1px solid #00ff87' : '1px solid #ff2a5f',
                        color: isMusicPlaying ? '#00ff87' : '#ff2a5f',
                        padding: '8px 16px',
                        borderRadius: '6px',
                        fontSize: '11px',
                        fontWeight: 'bold',
                        letterSpacing: '1px',
                        cursor: 'pointer',
                        boxShadow: isMusicPlaying ? '0 0 10px rgba(0, 255, 135, 0.2)' : '0 0 10px rgba(255, 42, 95, 0.2)'
                      }}
                    >
                      {isMusicPlaying ? t('online') : t('muted')}
                    </button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', textAlign: 'left' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#8a99ad', fontWeight: 'bold', letterSpacing: '1px' }}>
                      <span>{t('volumeLevel')}</span>
                      <span style={{ color: '#00f0ff' }}>{Math.round(volume * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={volume}
                      onChange={(e) => setVolume(parseFloat(e.target.value))}
                      className="volume-slider"
                      style={{
                        background: `linear-gradient(to right, #00f0ff 0%, #00f0ff ${volume * 100}%, rgba(255,255,255,0.1) ${volume * 100}%, rgba(255,255,255,0.1) 100%)`
                      }}
                    />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '13px', fontWeight: 'bold', letterSpacing: '1px', color: '#bdc7db' }}>{t('dopamineCorner')}</span>
                    <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={dopamineCorner}
                        onChange={(e) => setDopamineCorner(e.target.checked)}
                        style={{
                          width: '18px',
                          height: '18px',
                          accentColor: '#00f0ff',
                          cursor: 'pointer'
                        }}
                      />
                    </label>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', textAlign: 'left' }}>
                    <span style={{ fontSize: '13px', fontWeight: 'bold', letterSpacing: '1px', color: '#bdc7db' }}>{t('languages')}</span>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                      {APP_LANGUAGES.map((lang) => (
                        <button
                          key={lang.code}
                          onClick={() => setLanguage(lang.code)}
                          style={{
                            background: language === lang.code ? 'rgba(0, 240, 255, 0.12)' : 'rgba(255,255,255,0.04)',
                            border: language === lang.code ? '1px solid #00f0ff' : '1px solid rgba(255,255,255,0.15)',
                            color: language === lang.code ? '#00f0ff' : '#8a99ad',
                            padding: '8px 14px',
                            borderRadius: '6px',
                            fontSize: '11px',
                            fontWeight: 'bold',
                            letterSpacing: '0.5px',
                            cursor: 'pointer',
                            boxShadow: language === lang.code ? '0 0 10px rgba(0, 240, 255, 0.2)' : 'none'
                          }}
                        >
                          {lang.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', textAlign: 'left' }}>
                    <button
                      onClick={() => setShowContactSupportPopup(true)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '8px',
                        background: 'rgba(0, 240, 255, 0.08)',
                        border: '1px solid rgba(0, 240, 255, 0.35)',
                        color: '#00f0ff',
                        padding: '10px 16px',
                        borderRadius: '6px',
                        fontSize: '12px',
                        fontWeight: 'bold',
                        letterSpacing: '1px',
                        cursor: 'pointer'
                      }}
                    >
                      <Icon name="mail" size={14} />
                      {t('supportButton')}
                    </button>
                  </div>
                </div>
                <NeonButton variant="secondary" onClick={() => setCurrentScreen('main')}><Icon name="arrowLeft" size={13} style={{ marginRight: 6 }} />{t('back')}</NeonButton>
              </div>
            )}

            {/* --- SCREEN: TUTORIAL --- */}
            {currentScreen === 'tutorial' && (
              <div style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
            <h3 style={{ marginBottom: '20px', textAlign: 'center', color: '#00f0ff', fontSize: '20px', letterSpacing: '2px', flexShrink: 0 }}>{t('classifiedDossier')}</h3>

            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: '12px', fontSize: '13px', lineHeight: '1.6', color: '#bdc7db' }}>
              {language === 'ru' ? (
              <>
              <p style={{ fontWeight: 'bold', color: '#00f0ff', margin: '0 0 6px 0', letterSpacing: '1px' }}>1. ЛОББИ, ПЕРСОНАЖИ И СТАРТ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Комната рассчитана на <strong>5–12 агентов</strong>. Каждый выбирает одного из 12 уникальных персонажей — один и тот же персонаж не может принадлежать двум игрокам одновременно, но выбор свободно меняется до нажатия «Готов». Хост запускает подготовку кнопкой <strong>START OPERATION</strong>: вход в комнату блокируется, и все переключают готовность. В момент, когда готовы <strong>абсолютно все</strong>, автоматически стартует <strong>5-секундный отсчёт</strong> — если кто-то передумает, отсчёт тут же отменяется.
              </p>

              <p style={{ fontWeight: 'bold', color: '#00f0ff', margin: '0 0 6px 0', letterSpacing: '1px' }}>2. ЗАГРУЗКА И РАСКРЫТИЕ РОЛИ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Текст интро запускается только когда о загрузке отчитались <strong>все игроки</strong> — если чья-то вкладка свёрнута и застряла, сервер ждёт <strong>15 секунд</strong> и запускает игру принудительно, чтобы никто не мог заблокировать лобби навсегда. Роль назначается именно в этот момент и раскрывается <strong>только вам лично</strong> — сервер никому больше её не сообщает. Сама игра стартует аналогично: только когда все подтвердили, что досмотрели экран роли (снова с 15-секундной страховкой).
              </p>

              <p style={{ fontWeight: 'bold', color: '#ffeb3b', margin: '0 0 6px 0', letterSpacing: '1px' }}>3. ХОДЫ И ВРЕМЯ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Агенты действуют <strong>строго по очереди</strong>, порядок ходов перемешивается заново <strong>каждый раунд</strong> (и гарантированно отличается от прошлого раунда). У каждого есть до <strong>30 секунд</strong> на выбор сектора для обыска — это жёсткий серверный таймер. За ход разрешён <strong>ровно один обыск комнаты</strong>, но ход не заканчивается автоматически сразу после этого: вы остаётесь внутри, чтобы действовать, пока не нажмёте «Завершить ход» или не истечёт время. Если время истекло, а комната так и не выбрана — вас всё равно случайно поместят в одну из комнат для учёта. Если комната уже выбрана — ход просто завершается там, где вы есть. Штрафа нет ни в одном из случаев. <strong style={{ color: '#fff' }}>Карту особняка видит только тот, чей сейчас ход</strong> — все остальные живые агенты в это время видят лишь обратный отсчёт и обобщённую надпись «Агент действует», без карты и без возможности подглядеть комнаты, пока не наступит их собственный ход.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff9100', margin: '0 0 6px 0', letterSpacing: '1px' }}>4. ДВЕ ФАЗЫ РАУНДА</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                <strong>Фаза действий:</strong> скрытные манёвры и тактические действия, пока не сходят все живые агенты.<br />
                <strong>Фаза суда:</strong> короткое затемнение (~1,5 сек) → объявление и сводка по делу (~6 сек, показывает найденные тела и улики) → голосование (до 120 секунд, но завершается досрочно, как только зафиксировались все) → разрешение итога (~3,5 сек) → новый раунд или конец игры.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff9100', margin: '0 0 6px 0', letterSpacing: '1px' }}>5. ВЕНТИЛЯЦИОННЫЕ ХОДЫ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 10px 0' }}>
                Только <strong>Убийца</strong> имеет доступ к сети вентиляционных ходов, соединяющих определённые комнаты особняка попарно. Нужно уже находиться в одной из этих комнат, чтобы прыгнуть. Прыжок — это мгновенное перемещение <strong>в дополнение</strong> к обычному обыску, а не вместо него, и заново открывает действия в новой комнате (включая возможный триггер ловушки там). Разрешён только <strong>один прыжок через вентиляцию за ход</strong>.
              </p>
              <p style={{ color: '#ff9100', margin: '0 0 6px 0', fontSize: '12px', letterSpacing: '0.5px', textTransform: 'uppercase' }}>Известные соединения вентиляции:</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 18px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#fff' }}>Главный зал</strong> (1-й этаж) ↔ <strong style={{ color: '#fff' }}>Спальня хозяев</strong> (2-й этаж)</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#fff' }}>Кухня</strong> ↔ <strong style={{ color: '#fff' }}>Оружейная</strong> (оба на 1-м этаже)</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#fff' }}>Винный погреб</strong> (1-й этаж) ↔ <strong style={{ color: '#fff' }}>Чердак</strong> (2-й этаж)</li>
              </ul>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Кроме двух обыскиваемых этажей (по 10 комнат каждый) в особняке есть запертая <strong style={{ color: '#fff' }}>Камера содержания</strong> (1-й этаж, нижний правый угол — только для эффекта способности Офицера) и подвальная <strong style={{ color: '#fff' }}>Комната пыток</strong> — чисто атмосферная, но проходимая как обычная комната.
              </p>

              <p style={{ fontWeight: 'bold', color: '#00ff87', margin: '0 0 6px 0', letterSpacing: '1px' }}>6. ДЕЙСТВИЯ В КОМНАТЕ: ОБЫСК И ПОИСК ТЕЛА</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                За один визит в комнату доступно только <strong>одно</strong> из двух действий — <strong>«Обыскать комнату»</strong> или <strong>«Искать тело»</strong> — что бы вы ни нажали первым, второе блокируется до захода в другую комнату (новый обыск или прыжок через вент). «Обыскать комнату» ищет цифру кода (см. пункт 7) и заодно вскрывает любую подброшенную улику или лежащий здесь Нейротоксин-7 — отдельных кнопок для этого нет.
              </p>

              <p style={{ fontWeight: 'bold', color: '#00ff87', margin: '0 0 6px 0', letterSpacing: '1px' }}>7. ЦИФРОВОЙ КОД ОТМЕНЫ ПРОТОКОЛА</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Длина кода зависит от числа Невинных в лобби: <strong style={{ color: '#fff' }}>4 цифры за 1-го Невинного, +1 цифра за каждого следующего, максимум 10</strong>. Каждая цифра спрятана в своей случайной комнате на весь матч. Реальную цифру (и её позицию в коде) при обыске получают только <strong>Невинные</strong>, и мгновенно узнаёт вся их команда — все остальные роли получают одинаковый пустой результат, реальна там цифра или нет. Отдельная способность <strong>«Проверить комнату»</strong> (перезарядка <strong style={{ color: '#fff' }}>2 раунда</strong>, требует, чтобы обыск этой комнаты уже был сделан в этот ход) анонимно помечает комнату как чистую для всей команды Невинных — но если цифра реально там, комната никогда не помечается чистой, а сама цифра всё равно не раскрывается этой способностью.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 6px 0', letterSpacing: '1px' }}>8. СПРЯТАТЬ ИЛИ ОСТАВИТЬ ТЕЛО НА ВИДУ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Сразу после убийства <strong>Убийца</strong> должен выбрать: <strong>Спрятать</strong> тело — оно останется скрытым, пока кто-то намеренно не начнёт его искать, но это использует прыжок через вентиляцию в этот ход, так что вентилировать в этот ход нельзя — или <strong>Оставить на виду</strong>, чтобы его увидел следующий, кто зайдёт в комнату, при этом вентиляция остаётся доступной для использования позже. Если решение так и не принято до конца хода, сервер сам выбирает «Оставить на виду» — тело никогда не теряется молча. На каждое убийство есть также шанс, что Убийца случайно обронит личную вещь своего персонажа в случайной комнате где угодно в особняке (необязательно в комнате убийства) — об этом узнаёт только сам Убийца и, если он есть в игре, Сообщник. Шанс не фиксирован: он зависит от размера лобби (<strong style={{ color: '#fff' }}>от 65% при 5 агентах до 30% при 12</strong>) и растёт с каждым следующим убийством за матч (<strong style={{ color: '#fff' }}>+10% за предыдущее убийство, максимум +25%</strong>) — первая жертва самая «чистая», а к финалу матча улики оставляют почти гарантированно.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 6px 0', letterSpacing: '1px' }}>9. ОБНАРУЖЕНИЕ ТЕЛ — ВАЖНАЯ ДЕТАЛЬ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                В тот момент, когда кто-то успешно находит <strong>спрятанное</strong> тело через «Искать тело», оно перестаёт быть спрятанным <strong>навсегда, до конца матча</strong> — с этого момента любой, кто просто зайдёт в комнату (включая наблюдателей, просматривающих её), увидит его без поиска, спрятать обратно нельзя. Каждый, кто хоть раз увидел тело, навсегда попадает в список нашедших и позже отображается в сводке суда. Пока в особняке остаётся <strong>хотя бы одно необнаруженное</strong> тело, терминал выхода Невинных полностью отказывается принимать код, каким бы верным он ни был — но игра никогда не подсказывает, кто пропал и где. Казнённый советом игрок — противоположный случай: тело для него не создаётся вообще, искать нечего.
              </p>

              <p style={{ fontWeight: 'bold', color: '#bdef13', margin: '0 0 6px 0', letterSpacing: '1px' }}>10. КРИМИНАЛИСТИЧЕСКИЕ СЛЕДЫ НА ТЕЛАХ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                На каждом теле в момент его появления фиксируется ровно один тип следа — группа крови, категория роста или категория веса, по очереди — отражающий реальные характеристики настоящего Убийцы. Значение зафиксировано навсегда и не меняется со временем. Извлечь его может только <strong>Криминалист</strong> через «Осмотреть тело», только во время суда, и только на уже обнаруженном теле. Поскольку с одного тела раскрывается лишь одна категория, для полного профиля нужно осмотреть несколько разных тел за матч.
              </p>

              <p style={{ fontWeight: 'bold', color: '#00ff87', margin: '0 0 6px 0', letterSpacing: '1px' }}>11. УЛИКИ И ОБЩАЯ ДОСКА</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Оперативники находят подлинные следы, оставленные случайно. <strong>Сообщник</strong> может подделать уже найденную улику, подставив выбранного игрока — фальшивка при этом намеренно <strong>исчезает с общей доски</strong> и с этого момента видна только тому, кто лично повторно обыщет именно эту комнату. <strong>Джокер</strong> подбрасывает улики в стиле собственного персонажа осознанно — они, наоборот, попадают на общую доску сразу после обнаружения. Найденное тело/улика не исчезают и не «истекают» при смене раунда — они навсегда остаются доступными в этой комнате и в сводке. Если игрок нашёл улику через обыск, но в этом же раунде его убивает <strong>Убийца</strong>, засчитанная находка отменяется — улика возвращается в статус необнаруженной и остаётся лежать в комнате, пока её не найдёт кто-то ещё; если её в этом же раунде также нашёл кто-то другой из выживших, за ним находка сохраняется.
              </p>

              <p style={{ fontWeight: 'bold', color: '#e040fb', margin: '0 0 6px 0', letterSpacing: '1px' }}>12. НЕЙРОТОКСИН-7</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Ограниченное число шприцев (1–3 в зависимости от числа игроков) прячется в случайных комнатах и находится через обычный обыск. Трогать его могут только <strong>Убийца, Сообщник и Джокер</strong> — остальным он «слишком опасен» и остаётся на месте. Носить с собой можно только один за раз. У <strong>Убийцы</strong> он поднимает лимит убийств до <strong style={{ color: '#fff' }}>двух за раунд</strong> и расходуется после второго убийства. У <strong>Сообщника/Джокера</strong> он работает как <strong>пассивный щит</strong>: полностью нейтрализует ближайшую прямую атаку Убийцы и расходуется при срабатывании — но неудачная атака на защищённую цель всё равно сжигает у Убийцы <strong>весь ресурс убийств на раунд</strong>, даже если у него самого есть свой неизрасходованный шприц. Щит не спасает от казни советом.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff9100', margin: '0 0 6px 0', letterSpacing: '1px' }}>13. ЛОВУШКИ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                <strong>Сообщник</strong> может установить в комнате скрытую ловушку (<strong style={{ color: '#fff' }}>1 раз в 4 раунда</strong>). Первый агент любой роли, зашедший в эту комнату — обычным шагом или через вентиляцию — активирует её: ловушка срабатывает мгновенно и расходуется, а этот агент лишается вообще всех действий и способностей на весь следующий раунд, включая фазу действий и суд (даже терминал выхода откажет ему во вводе). Убийца приватно узнаёт, где его Сообщник поставил ловушку.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 8px 0', letterSpacing: '1px' }}>14. АКТИВНЫЕ РОЛИ ПОДРОБНО</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 18px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#ff2a5f' }}>Убийца:</strong> устраняет цели (<strong style={{ color: '#fff' }}>1 за ход</strong>, 2 с Нейротоксином), затем решает судьбу тела, имеет доступ к вентиляции.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#ff9100' }}>Сообщник</strong> (от 8 игроков): может подделать уже найденную улику, подставив игрока (<strong style={{ color: '#fff' }}>1 раз в 3 своих хода</strong>), и установить ловушку в комнате (<strong style={{ color: '#fff' }}>1 раз в 4 раунда</strong>). Приватно узнаёт об оговорках Убийцы.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#00f0ff' }}>Детектив:</strong> во время суда проверяет, в какой комнате выбранный игрок завершил <em>предыдущий</em> ход — снимок фиксируется в момент начала суда (<strong style={{ color: '#fff' }}>1 раз в 2 раунда</strong>). Себя проверить нельзя. Результат виден только вам.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#2979ff' }}>Офицер:</strong> во время суда планирует запереть подозреваемого (или <em>себя самого</em>) в Камере содержания на весь <em>следующий</em> раунд (<strong style={{ color: '#fff' }}>1 раз в 3 раунда</strong>). Запертый игрок полностью невидим для всех, включая наблюдателей, и лишён любых действий и способностей весь раунд.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#bdef13' }}>Криминалист</strong> (от 8 игроков): «Проверить подлинность улики» (реальна или сфабрикована) ИЛИ «Осмотреть тело» на след Убийцы — оба действия делят <strong style={{ color: '#fff' }}>одну общую перезарядку в 1 раунд</strong>. Повторный запрос уже осмотренного тела бесплатен — результат кешируется.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#e040fb' }}>Джокер</strong> (от 8 игроков): побеждает <em>только</em> если казнён советом — никак иначе. Может подбросить личную улику в <em>любую</em> комнату особняка (<strong style={{ color: '#fff' }}>1 раз в 2 своих хода</strong>). Единственная роль, которой разрешено голосовать за себя на суде.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#00ff87' }}>Невинный:</strong> без наступательных способностей. Ищет по особняку цифры кода отмены протокола (общие для всей команды) и может анонимно помечать проверенные комнаты (<strong style={{ color: '#fff' }}>1 раз в 2 раунда</strong>). Только Невинные могут ввести собранный код и выиграть матч.</li>
              </ul>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 6px 0', letterSpacing: '1px' }}>15. ГОЛОСОВАНИЕ И ИТОГИ СУДА</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Каждый активный игрок голосует за конкретного подозреваемого или явно за <strong>пропуск</strong>; голосовать за себя нельзя — кроме Джокера. Голос засчитывается только зафиксированным, но его можно свободно менять до истечения таймера или до того, как зафиксируются все. Кандидат казнён, только если у него <strong>строго больше всех</strong> голосов, нет ничьей за первое место, и его результат строго превышает пропуск — иначе в этом раунде никого не казнят. Казнённый игрок не оставляет тела.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ffeb3b', margin: '0 0 6px 0', letterSpacing: '1px' }}>16. УСЛОВИЯ ПОБЕДЫ</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 18px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}>Невинный вводит верный код на суде при отсутствии необнаруженных тел — <strong style={{ color: '#00ff87' }}>победа Невинных</strong>.</li>
                <li style={{ marginBottom: '6px' }}>Совет казнит <strong style={{ color: '#ff2a5f' }}>Убийцу</strong> — немедленная <strong style={{ color: '#00ff87' }}>победа Невинных</strong>, независимо от числа выживших.</li>
                <li style={{ marginBottom: '6px' }}>Совет казнит <strong style={{ color: '#e040fb' }}>Джокера</strong> — он побеждает в одиночку.</li>
                <li style={{ marginBottom: '6px' }}>Число активных мирных игроков опускается до уровня или ниже числа активных членов команды Убийцы (Убийца + Сообщник) — немедленная <strong style={{ color: '#ff2a5f' }}>победа команды Убийцы</strong>. Джокер не учитывается ни в одну из сторон этого подсчёта.</li>
                <li style={{ marginBottom: '6px' }}>Вся команда Убийцы покинула матч, а мирные остались — по умолчанию <strong style={{ color: '#00ff87' }}>победа Невинных</strong>.</li>
              </ul>

              <p style={{ fontWeight: 'bold', color: '#9e9e9e', margin: '0 0 6px 0', letterSpacing: '1px' }}>17. ПРОТОКОЛ ПРИЗРАКА (ПОГИБШИЕ)</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Терминальная передача прервана, но доступ открывает <strong style={{ color: '#00ff87' }}>неограниченный спутниковый обзор карты</strong> — можно свободно просматривать любую комнату вживую, но не действовать. Чат заблокирован для погибших/наблюдателей именно во время фазы суда, но доступен в остальное время.
              </p>

              <p style={{ fontWeight: 'bold', color: '#9e9e9e', margin: '0 0 6px 0', letterSpacing: '1px' }}>18. МЕЛКИЕ ФИШКИ, О КОТОРЫХ ЛЕГКО ЗАБЫТЬ</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 5px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}>Найденная цифра сопровождается её точной позицией в коде — команда собирает код по порядку, а не гадает.</li>
                <li style={{ marginBottom: '6px' }}>Случайно оброненная улика Убийцы может оказаться в любой комнате особняка, включая ту, где ещё никто не был.</li>
                <li style={{ marginBottom: '6px' }}>Подделанная Сообщником улика никогда не появляется на общей доске — только для того, кто лично обыщет ту же комнату.</li>
                <li style={{ marginBottom: '6px' }}>Офицер может запереть в камере <em>самого себя</em> — запрета на это нет, в отличие от способности Детектива.</li>
                <li style={{ marginBottom: '6px' }}>Обе способности Криминалиста делят одну перезарядку — использовав одну, вторая тоже уходит в кулдаун.</li>
                <li style={{ marginBottom: '6px' }}>Щит Нейротоксина-7 никогда не спасает от голосования совета — только от прямой атаки Убийцы.</li>
                <li style={{ marginBottom: '6px' }}>Сервер технически рассылает личность запертого в Камере содержания игрока всем клиентам (не только Офицеру), но интерфейс её нигде не отображает — на экране видно только «это я?», поэтому на практике никто, кроме самого запертого, не узнаёт, кто внутри.</li>
                <li style={{ marginBottom: '6px' }}>Если вы явно не выбрали персонажа, но нажали «Готов» с персонажем, уже приложенным к этому запросу, сервер молча примет тот персонаж, что пришёл вместе с переключением готовности.</li>
                <li style={{ marginBottom: '6px' }}>Пропуск текста интро реально происходит только тогда, когда за него проголосуют абсолютно все игроки — не большинство.</li>
                <li style={{ marginBottom: '6px' }}>Наблюдая любую комнату (как наблюдатель или устранённый), при изменениях там (найдено тело, подброшена улика, зашли/вышли игроки) ваш вид обновляется в реальном времени — заново выбирать комнату не нужно.</li>
                <li style={{ marginBottom: '6px' }}>Приватный код комнаты — это 8-символьный HEX-код (буквы и цифры, регистр не важен), а не просто число.</li>
              </ul>
              </>
              ) : language === 'uk' ? (
              <>
              <p style={{ fontWeight: 'bold', color: '#00f0ff', margin: '0 0 6px 0', letterSpacing: '1px' }}>1. ЛОБІ, ПЕРСОНАЖІ ТА СТАРТ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Кімната розрахована на <strong>5–12 агентів</strong>. Кожен обирає одного з 12 унікальних персонажів — один і той самий персонаж не може належати двом гравцям одночасно, але вибір вільно змінюється до натискання «Готовий». Хост запускає підготовку кнопкою <strong>START OPERATION</strong>: вхід до кімнати блокується, і всі перемикають готовність. У момент, коли готові <strong>абсолютно всі</strong>, автоматично стартує <strong>5-секундний відлік</strong> — якщо хтось передумає, відлік одразу скасовується.
              </p>

              <p style={{ fontWeight: 'bold', color: '#00f0ff', margin: '0 0 6px 0', letterSpacing: '1px' }}>2. ЗАВАНТАЖЕННЯ ТА РОЗКРИТТЯ РОЛІ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Текст інтро запускається лише тоді, коли про завантаження відзвітували <strong>всі гравці</strong> — якщо чиясь вкладка згорнута і застрягла, сервер чекає <strong>15 секунд</strong> і примусово запускає гру, щоб ніхто не міг заблокувати лобі назавжди. Роль призначається саме в цю мить і розкривається <strong>лише вам особисто</strong> — сервер більше нікому її не повідомляє. Сама гра стартує так само: лише коли всі підтвердили, що переглянули екран ролі (знову з 15-секундною страховкою).
              </p>

              <p style={{ fontWeight: 'bold', color: '#ffeb3b', margin: '0 0 6px 0', letterSpacing: '1px' }}>3. ХОДИ ТА ЧАС</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Агенти діють <strong>строго по черзі</strong>, порядок ходів перемішується заново <strong>кожен раунд</strong> (і гарантовано відрізняється від минулого раунду). У кожного є до <strong>30 секунд</strong> на вибір сектора для обшуку — це жорсткий серверний таймер. За хід дозволено <strong>рівно один обшук кімнати</strong>, але хід не завершується автоматично одразу після цього: ви лишаєтеся всередині, щоб діяти, поки не натиснете «Завершити хід» або не мине час. Якщо час минув, а кімнату так і не обрано — вас все одно випадково розмістять в одній із кімнат для обліку. Якщо кімнату вже обрано — хід просто завершується там, де ви є. Штрафу немає в жодному з випадків. <strong style={{ color: '#fff' }}>Карту особняка бачить лише той, чий зараз хід</strong> — усі інші живі агенти в цей час бачать лише зворотний відлік і узагальнений напис «Агент діє», без карти й без можливості підглянути кімнати, поки не настане їхній власний хід.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff9100', margin: '0 0 6px 0', letterSpacing: '1px' }}>4. ДВІ ФАЗИ РАУНДУ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                <strong>Фаза дій:</strong> потайні маневри й тактичні дії, поки не сходять усі живі агенти.<br />
                <strong>Фаза суду:</strong> коротке затемнення (~1,5 сек) → оголошення та зведення по справі (~6 сек, показує знайдені тіла й докази) → голосування (до 120 секунд, але завершується достроково, щойно зафіксувалися всі) → розв'язання підсумку (~3,5 сек) → новий раунд або кінець гри.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff9100', margin: '0 0 6px 0', letterSpacing: '1px' }}>5. ВЕНТИЛЯЦІЙНІ ХОДИ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 10px 0' }}>
                Лише <strong>Вбивця</strong> має доступ до мережі вентиляційних ходів, що з'єднують певні кімнати особняка попарно. Потрібно вже перебувати в одній із цих кімнат, щоб стрибнути. Стрибок — це миттєве переміщення <strong>на додачу</strong> до звичайного обшуку, а не замість нього, і заново відкриває дії в новій кімнаті (включно з можливим спрацюванням пастки там). Дозволено лише <strong>один стрибок через вентиляцію за хід</strong>.
              </p>
              <p style={{ color: '#ff9100', margin: '0 0 6px 0', fontSize: '12px', letterSpacing: '0.5px', textTransform: 'uppercase' }}>Відомі з'єднання вентиляції:</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 18px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#fff' }}>Головна зала</strong> (1-й поверх) ↔ <strong style={{ color: '#fff' }}>Спальня господарів</strong> (2-й поверх)</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#fff' }}>Кухня</strong> ↔ <strong style={{ color: '#fff' }}>Зброярня</strong> (обидві на 1-му поверсі)</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#fff' }}>Винний погріб</strong> (1-й поверх) ↔ <strong style={{ color: '#fff' }}>Горище</strong> (2-й поверх)</li>
              </ul>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Окрім двох обшукуваних поверхів (по 10 кімнат кожен), в особняку є замкнена <strong style={{ color: '#fff' }}>Камера утримання</strong> (1-й поверх, нижній правий кут — лише для ефекту здібності Офіцера) і підвальна <strong style={{ color: '#fff' }}>Катівня</strong> — суто атмосферна, але прохідна як звичайна кімната.
              </p>

              <p style={{ fontWeight: 'bold', color: '#00ff87', margin: '0 0 6px 0', letterSpacing: '1px' }}>6. ДІЇ В КІМНАТІ: ОБШУК І ПОШУК ТІЛА</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                За один візит до кімнати доступна лише <strong>одна</strong> з двох дій — <strong>«Обшукати кімнату»</strong> або <strong>«Шукати тіло»</strong> — що б ви не натиснули першим, друге блокується до заходу в іншу кімнату (новий обшук або стрибок через вент). «Обшукати кімнату» шукає цифру коду (див. пункт 7) і заодно розкриває будь-який підкинутий доказ або Нейротоксин-7, що лежить тут — окремих кнопок для цього немає.
              </p>

              <p style={{ fontWeight: 'bold', color: '#00ff87', margin: '0 0 6px 0', letterSpacing: '1px' }}>7. ЦИФРОВИЙ КОД СКАСУВАННЯ ПРОТОКОЛУ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Довжина коду залежить від кількості Невинних у лобі: <strong style={{ color: '#fff' }}>4 цифри за 1-го Невинного, +1 цифра за кожного наступного, максимум 10</strong>. Кожна цифра захована у своїй випадковій кімнаті на весь матч. Реальну цифру (і її позицію в коді) під час обшуку отримують лише <strong>Невинні</strong>, і миттєво дізнається вся їхня команда — усі інші ролі отримують однаковий порожній результат, реальна там цифра чи ні. Окрема здібність <strong>«Перевірити кімнату»</strong> (перезарядка <strong style={{ color: '#fff' }}>2 раунди</strong>, потребує, щоб обшук цієї кімнати вже було зроблено цього ходу) анонімно позначає кімнату як чисту для всієї команди Невинних — але якщо цифра реально там, кімната ніколи не позначається чистою, а сама цифра все одно не розкривається цією здібністю.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 6px 0', letterSpacing: '1px' }}>8. СХОВАТИ АБО ЗАЛИШИТИ ТІЛО НА ВИДУ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Одразу після вбивства <strong>Вбивця</strong> повинен обрати: <strong>Сховати</strong> тіло — воно залишиться прихованим, поки хтось навмисно не почне його шукати, але це використає стрибок через вентиляцію цього ходу, тож вентилювати цього ходу не можна — або <strong>Залишити на видноті</strong>, щоб його побачив наступний, хто зайде в кімнату, при цьому вентиляція залишається доступною для використання пізніше. Якщо рішення так і не прийнято до кінця ходу, сервер сам обирає «Залишити на видноті» — тіло ніколи не втрачається мовчки. На кожне вбивство є також шанс, що Вбивця випадково впустить особисту річ свого персонажа у випадковій кімнаті будь-де в особняку (необов'язково в кімнаті вбивства) — про це дізнається лише сам Вбивця і, якщо він є у грі, Спільник. Шанс не фіксований: він залежить від розміру лобі (<strong style={{ color: '#fff' }}>від 65% при 5 агентах до 30% при 12</strong>) і зростає з кожним наступним вбивством за матч (<strong style={{ color: '#fff' }}>+10% за попереднє вбивство, максимум +25%</strong>) — перша жертва найчистіша, а до фіналу матчу докази лишаються майже гарантовано.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 6px 0', letterSpacing: '1px' }}>9. ВИЯВЛЕННЯ ТІЛ — ВАЖЛИВА ДЕТАЛЬ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                У ту мить, коли хтось успішно знаходить <strong>приховане</strong> тіло через «Шукати тіло», воно перестає бути прихованим <strong>назавжди, до кінця матчу</strong> — з цього моменту будь-хто, хто просто зайде в кімнату (включно зі спостерігачами, що переглядають її), побачить його без пошуку, сховати назад не можна. Кожен, хто хоч раз побачив тіло, назавжди потрапляє до списку тих, хто знайшов, і пізніше відображається у зведенні суду. Поки в особняку залишається <strong>хоча б одне невиявлене</strong> тіло, термінал виходу Невинних повністю відмовляється приймати код, яким би вірним він не був — але гра ніколи не підказує, хто пропав і де. Страчений радою гравець — протилежний випадок: тіло для нього взагалі не створюється, шукати нічого.
              </p>

              <p style={{ fontWeight: 'bold', color: '#bdef13', margin: '0 0 6px 0', letterSpacing: '1px' }}>10. КРИМІНАЛІСТИЧНІ СЛІДИ НА ТІЛАХ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                На кожному тілі в момент його появи фіксується рівно один тип сліду — група крові, категорія зросту або категорія ваги, по черзі — що відображає реальні характеристики справжнього Вбивці. Значення зафіксоване назавжди і не змінюється з часом. Видобути його може лише <strong>Криміналіст</strong> через «Оглянути тіло», лише під час суду, і лише на вже виявленому тілі. Оскільки з одного тіла розкривається лише одна категорія, для повного профілю потрібно оглянути кілька різних тіл за матч.
              </p>

              <p style={{ fontWeight: 'bold', color: '#00ff87', margin: '0 0 6px 0', letterSpacing: '1px' }}>11. ДОКАЗИ ТА СПІЛЬНА ДОШКА</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Оперативники знаходять справжні сліди, залишені випадково. <strong>Спільник</strong> може підробити вже знайдений доказ, підставивши обраного гравця — фальшивка при цьому навмисно <strong>зникає зі спільної дошки</strong> і з цього моменту видима лише тому, хто особисто повторно обшукає саме цю кімнату. <strong>Джокер</strong> підкидає докази у стилі власного персонажа свідомо — вони, навпаки, потрапляють на спільну дошку одразу після виявлення. Знайдене тіло/доказ не зникають і не «спливають» при зміні раунду — вони назавжди залишаються доступними в цій кімнаті та в зведенні. Якщо гравець знайшов доказ через обшук, але в цьому ж раунді його вбиває <strong>Вбивця</strong>, зарахована знахідка скасовується — доказ повертається у статус невиявленого і залишається лежати в кімнаті, доки його не знайде хтось інший; якщо цей доказ цього ж раунду також знайшов хтось інший із живих, за ним знахідка зберігається.
              </p>

              <p style={{ fontWeight: 'bold', color: '#e040fb', margin: '0 0 6px 0', letterSpacing: '1px' }}>12. НЕЙРОТОКСИН-7</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Обмежена кількість шприців (1–3 залежно від кількості гравців) ховається у випадкових кімнатах і знаходиться через звичайний обшук. Торкатися його можуть лише <strong>Вбивця, Спільник і Джокер</strong> — для інших він «занадто небезпечний» і залишається на місці. Носити з собою можна лише один за раз. У <strong>Вбивці</strong> він піднімає ліміт вбивств до <strong style={{ color: '#fff' }}>двох за раунд</strong> і витрачається після другого вбивства. У <strong>Спільника/Джокера</strong> він працює як <strong>пасивний щит</strong>: повністю нейтралізує найближчу пряму атаку Вбивці і витрачається при спрацюванні — але невдала атака на захищену ціль все одно спалює у Вбивці <strong>весь ресурс вбивств на раунд</strong>, навіть якщо в нього самого є свій невитрачений шприц. Щит не рятує від страти радою.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff9100', margin: '0 0 6px 0', letterSpacing: '1px' }}>13. ПАСТКИ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                <strong>Спільник</strong> може встановити в кімнаті приховану пастку (<strong style={{ color: '#fff' }}>1 раз на 4 раунди</strong>). Перший агент будь-якої ролі, що зайшов до цієї кімнати — звичайним кроком або через вентиляцію — активує її: пастка спрацьовує миттєво і витрачається, а цей агент втрачає взагалі всі дії та здібності на весь наступний раунд, включно з фазою дій і судом (навіть термінал виходу відмовить йому у введенні). Вбивця приватно дізнається, де його Спільник поставив пастку.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 8px 0', letterSpacing: '1px' }}>14. АКТИВНІ РОЛІ ДОКЛАДНО</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 18px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#ff2a5f' }}>Вбивця:</strong> усуває цілі (<strong style={{ color: '#fff' }}>1 за хід</strong>, 2 з Нейротоксином), потім вирішує долю тіла, має доступ до вентиляції.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#ff9100' }}>Спільник</strong> (від 8 гравців): може підробити вже знайдений доказ, підставивши гравця (<strong style={{ color: '#fff' }}>1 раз на 3 своїх ходи</strong>), і встановити пастку в кімнаті (<strong style={{ color: '#fff' }}>1 раз на 4 раунди</strong>). Приватно дізнається про помилки Вбивці.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#00f0ff' }}>Детектив:</strong> під час суду перевіряє, в якій кімнаті обраний гравець завершив <em>попередній</em> хід — знімок фіксується в момент початку суду (<strong style={{ color: '#fff' }}>1 раз на 2 раунди</strong>). Себе перевірити не можна. Результат видно лише вам.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#2979ff' }}>Офіцер:</strong> під час суду планує замкнути підозрюваного (або <em>самого себе</em>) в Камері утримання на весь <em>наступний</em> раунд (<strong style={{ color: '#fff' }}>1 раз на 3 раунди</strong>). Замкнений гравець повністю невидимий для всіх, включно зі спостерігачами, і позбавлений будь-яких дій і здібностей весь раунд.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#bdef13' }}>Криміналіст</strong> (від 8 гравців): «Перевірити автентичність доказу» (реальний чи сфабрикований) АБО «Оглянути тіло» на слід Вбивці — обидві дії ділять <strong style={{ color: '#fff' }}>одну спільну перезарядку в 1 раунд</strong>. Повторний запит вже оглянутого тіла безкоштовний — результат кешується.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#e040fb' }}>Джокер</strong> (від 8 гравців): перемагає <em>лише</em> якщо страчений радою — жодним іншим чином. Може підкинути особистий доказ у <em>будь-яку</em> кімнату особняка (<strong style={{ color: '#fff' }}>1 раз на 2 своїх ходи</strong>). Єдина роль, якій дозволено голосувати за себе на суді.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#00ff87' }}>Невинний:</strong> без наступальних здібностей. Шукає по особняку цифри коду скасування протоколу (спільні для всієї команди) і може анонімно позначати перевірені кімнати (<strong style={{ color: '#fff' }}>1 раз на 2 раунди</strong>). Лише Невинні можуть ввести зібраний код і виграти матч.</li>
              </ul>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 6px 0', letterSpacing: '1px' }}>15. ГОЛОСУВАННЯ ТА ПІДСУМКИ СУДУ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Кожен активний гравець голосує за конкретного підозрюваного або явно за <strong>пропуск</strong>; голосувати за себе не можна — крім Джокера. Голос зараховується лише зафіксований, але його можна вільно змінювати до закінчення таймера або поки не зафіксувалися всі. Кандидата страчено, лише якщо в нього <strong>строго найбільше</strong> голосів, немає нічиєї за перше місце, і його результат строго перевищує пропуск — інакше цього раунду нікого не страчують. Страчений гравець не залишає тіла.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ffeb3b', margin: '0 0 6px 0', letterSpacing: '1px' }}>16. УМОВИ ПЕРЕМОГИ</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 18px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}>Невинний вводить правильний код на суді за відсутності невиявлених тіл — <strong style={{ color: '#00ff87' }}>перемога Невинних</strong>.</li>
                <li style={{ marginBottom: '6px' }}>Рада страчує <strong style={{ color: '#ff2a5f' }}>Вбивцю</strong> — негайна <strong style={{ color: '#00ff87' }}>перемога Невинних</strong>, незалежно від кількості вцілілих.</li>
                <li style={{ marginBottom: '6px' }}>Рада страчує <strong style={{ color: '#e040fb' }}>Джокера</strong> — він перемагає одноосібно.</li>
                <li style={{ marginBottom: '6px' }}>Кількість активних мирних гравців опускається до рівня або нижче кількості активних членів команди Вбивці (Вбивця + Спільник) — негайна <strong style={{ color: '#ff2a5f' }}>перемога команди Вбивці</strong>. Джокер не враховується в жодну зі сторін цього підрахунку.</li>
                <li style={{ marginBottom: '6px' }}>Уся команда Вбивці покинула матч, а мирні залишилися — за замовчуванням <strong style={{ color: '#00ff87' }}>перемога Невинних</strong>.</li>
              </ul>

              <p style={{ fontWeight: 'bold', color: '#9e9e9e', margin: '0 0 6px 0', letterSpacing: '1px' }}>17. ПРОТОКОЛ ПРИВИДА (ЗАГИБЛІ)</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Термінальну передачу перервано, але доступ відкриває <strong style={{ color: '#00ff87' }}>необмежений супутниковий огляд карти</strong> — можна вільно переглядати будь-яку кімнату наживо, але не діяти. Чат заблокований для загиблих/спостерігачів саме під час фази суду, але доступний в інший час.
              </p>

              <p style={{ fontWeight: 'bold', color: '#9e9e9e', margin: '0 0 6px 0', letterSpacing: '1px' }}>18. ДРІБНІ ДЕТАЛІ, ПРО ЯКІ ЛЕГКО ЗАБУТИ</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 5px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}>Знайдена цифра супроводжується її точною позицією в коді — команда збирає код по порядку, а не вгадує.</li>
                <li style={{ marginBottom: '6px' }}>Випадково впущений доказ Вбивці може опинитися в будь-якій кімнаті особняка, включно з тією, де ще ніхто не був.</li>
                <li style={{ marginBottom: '6px' }}>Підроблений Спільником доказ ніколи не з'являється на спільній дошці — лише для того, хто особисто обшукає ту саму кімнату.</li>
                <li style={{ marginBottom: '6px' }}>Офіцер може замкнути в камері <em>самого себе</em> — заборони на це немає, на відміну від здібності Детектива.</li>
                <li style={{ marginBottom: '6px' }}>Обидві здібності Криміналіста ділять одну перезарядку — використавши одну, друга теж іде на перезарядку.</li>
                <li style={{ marginBottom: '6px' }}>Щит Нейротоксину-7 ніколи не рятує від голосування ради — лише від прямої атаки Вбивці.</li>
                <li style={{ marginBottom: '6px' }}>Сервер технічно розсилає особу замкненого в Камері утримання гравця всім клієнтам (не лише Офіцеру), але інтерфейс її ніде не відображає — на екрані видно лише «це я?», тому на практиці ніхто, крім самого замкненого, не дізнається, хто всередині.</li>
                <li style={{ marginBottom: '6px' }}>Якщо ви явно не обрали персонажа, але натиснули «Готовий» із персонажем, уже прикріпленим до цього запиту, сервер мовчки прийме той персонаж, що прийшов разом із перемиканням готовності.</li>
                <li style={{ marginBottom: '6px' }}>Пропуск тексту інтро насправді відбувається лише тоді, коли за нього проголосують абсолютно всі гравці — не більшість.</li>
                <li style={{ marginBottom: '6px' }}>Спостерігаючи будь-яку кімнату (як спостерігач або усунений), при змінах там (знайдено тіло, підкинуто доказ, зайшли/вийшли гравці) ваш вигляд оновлюється в реальному часі — заново обирати кімнату не потрібно.</li>
                <li style={{ marginBottom: '6px' }}>Приватний код кімнати — це 8-символьний HEX-код (літери й цифри, регістр не важливий), а не просто число.</li>
              </ul>
              </>
              ) : language === 'es' ? (
              <>
              <p style={{ fontWeight: 'bold', color: '#00f0ff', margin: '0 0 6px 0', letterSpacing: '1px' }}>1. SALA, PERSONAJES E INICIO</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Las salas admiten <strong>5–12 agentes</strong>. Cada uno elige uno de los 12 personajes únicos — dos jugadores no pueden tener el mismo, pero puedes cambiarlo libremente hasta que marques Listo. El anfitrión bloquea la sala e inicia la preparación con <strong>START OPERATION</strong>, y luego todos alternan su estado de listo. En el instante en que <strong>todos y cada uno</strong> están listos, se inicia automáticamente una <strong>cuenta atrás de 5 segundos</strong> — si alguien deja de estar listo, se cancela de inmediato.
              </p>

              <p style={{ fontWeight: 'bold', color: '#00f0ff', margin: '0 0 6px 0', letterSpacing: '1px' }}>2. CARGA Y REVELACIÓN DE ROL</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                El texto de introducción solo empieza cuando <strong>todos los jugadores</strong> han confirmado que terminaron de cargar — si una pestaña queda en segundo plano y se atasca, el servidor espera <strong>15 segundos</strong> y luego fuerza el inicio de todos modos, para que nadie pueda bloquear la sala indefinidamente. Tu rol se asigna en ese preciso momento y se revela <strong>solo a ti</strong> — el servidor nunca se lo dice a nadie más. La partida en sí empieza del mismo modo: solo cuando todos han confirmado que terminaron de ver la pantalla de su rol (con la misma protección de 15 segundos).
              </p>

              <p style={{ fontWeight: 'bold', color: '#ffeb3b', margin: '0 0 6px 0', letterSpacing: '1px' }}>3. TURNOS Y TIEMPO</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Los agentes actúan <strong>estrictamente en orden</strong>, y el orden de turnos se reordena cada ronda (garantizado distinto al de la ronda anterior). Cada uno dispone de hasta <strong>30 segundos</strong> — un temporizador estricto del servidor — para elegir un sector que registrar. Tienes <strong>exactamente un registro por turno</strong>, pero el turno no termina automáticamente en cuanto registras — permaneces en la sala hasta que pulses Terminar Turno o se agote el tiempo. Si el tiempo se agota sin haber elegido una sala, de todos modos se te coloca al azar en una para efectos de registro; si el tiempo se agota tras haber elegido una, el turno simplemente termina donde estás. Ninguno de los dos casos conlleva penalización. <strong style={{ color: '#fff' }}>El mapa de la mansión solo es visible para quien tiene el turno en ese momento</strong> — todos los demás agentes vivos solo ven la cuenta atrás y una etiqueta genérica «UN AGENTE ACTÚA», sin mapa y sin forma de espiar ninguna sala, hasta que llegue su propio turno.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff9100', margin: '0 0 6px 0', letterSpacing: '1px' }}>4. DOS FASES POR RONDA</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                <strong>Fase de acciones:</strong> maniobras encubiertas y ejecución táctica hasta que todos los agentes vivos se hayan movido.<br />
                <strong>Fase de juicio:</strong> un breve apagón (~1,5 s) → anuncio del caso con un resumen de hallazgos (~6 s) → votación (hasta 120 s, se resuelve antes si todos confirman su voto) → resolución (~3,5 s) → una nueva ronda o el fin de la partida.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff9100', margin: '0 0 6px 0', letterSpacing: '1px' }}>5. ATAJOS POR CONDUCTOS DE VENTILACIÓN</p>
              <p style={{ color: '#8a99ad', margin: '0 0 10px 0' }}>
                Solo el <strong>Asesino</strong> puede acceder a una red de atajos por conductos que conecta salas concretas de la mansión en pares. Debes estar ya en una de ellas para saltar. El salto es instantáneo y se suma <strong>además de</strong> tu registro normal, no en su lugar, y reactiva tus opciones de sala en el destino (incluida cualquier trampa que espere allí). Solo se permite <strong>un salto de conducto por turno</strong>.
              </p>
              <p style={{ color: '#ff9100', margin: '0 0 6px 0', fontSize: '12px', letterSpacing: '0.5px', textTransform: 'uppercase' }}>Conexiones de conductos conocidas:</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 18px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#fff' }}>Gran Salón</strong> (1ª planta) ↔ <strong style={{ color: '#fff' }}>Dormitorio Principal</strong> (2ª planta)</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#fff' }}>Cocina</strong> ↔ <strong style={{ color: '#fff' }}>Armería</strong> (ambas en la 1ª planta)</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#fff' }}>Bodega</strong> (1ª planta) ↔ <strong style={{ color: '#fff' }}>Ático</strong> (2ª planta)</li>
              </ul>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Más allá de las dos plantas registrables (10 salas cada una), la mansión también tiene una <strong style={{ color: '#fff' }}>Celda</strong> cerrada (1ª planta, esquina inferior derecha — solo relevante para la habilidad del Oficial) y una <strong style={{ color: '#fff' }}>Sala de Tortura</strong> en el sótano — puramente ambiental, pero recorrible como cualquier sala normal.
              </p>

              <p style={{ fontWeight: 'bold', color: '#00ff87', margin: '0 0 6px 0', letterSpacing: '1px' }}>6. ACCIONES EN LA SALA: REGISTRAR SALA VS. BUSCAR CUERPO</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Cada visita a una sala te ofrece exactamente <strong>una</strong> de dos opciones — <strong>Registrar Sala</strong> o <strong>Buscar Cuerpo</strong> — la que elijas primero bloquea la otra hasta que entres en una sala distinta (un nuevo registro o un salto de conducto). Registrar Sala también se encarga de encontrar cualquier prueba plantada o una jeringa de Neurotoxina-7 que haya allí — no hay botones separados para eso.
              </p>

              <p style={{ fontWeight: 'bold', color: '#00ff87', margin: '0 0 6px 0', letterSpacing: '1px' }}>7. EL CÓDIGO DIGITAL DE ANULACIÓN</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                La longitud del código escala con el número de Inocentes en la sala: <strong style={{ color: '#fff' }}>4 dígitos para 1 Inocente, +1 por cada uno adicional, con un máximo de 10</strong>. Cada dígito se esconde en su propia sala aleatoria durante toda la partida. Solo los <strong>Inocentes</strong> obtienen alguna vez un dígito real (junto con su posición exacta) al registrar una sala que tenga uno, y en el momento en que eso ocurre, todo el equipo se entera al instante — cualquier otro rol recibe el mismo resultado vacío, tenga o no realmente un dígito. Una habilidad aparte, <strong>Revisar Sala</strong> (<strong style={{ color: '#fff' }}>recarga de 2 rondas</strong>, requiere que esa sala ya haya sido registrada este turno), marca anónimamente una sala como limpia para todo el equipo de Inocentes — pero una sala que realmente tiene un dígito nunca se marca como limpia, y esta habilidad nunca revela el dígito en sí.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 6px 0', letterSpacing: '1px' }}>8. OCULTAR O EXPONER EL CUERPO</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Justo después de un asesinato, el <strong>Asesino</strong> debe elegir: <strong>Ocultar</strong> el cuerpo — permanece escondido hasta que alguien lo busque deliberadamente, pero esto consume el salto de conducto de ese turno, así que no se puede usar el conducto ese turno — o <strong>Exponerlo</strong>, dejándolo a la vista de quien entre después, mientras el conducto sigue libre para usarse más tarde. Si nunca se toma la decisión, el servidor opta por Exponer de forma predeterminada — un cuerpo nunca se pierde silenciosamente. Cada asesinato también conlleva una probabilidad de que el Asesino deje caer accidentalmente uno de los objetos de su propio personaje en algún lugar aleatorio de la mansión, no necesariamente en la sala del crimen — solo se informa al Asesino (y, si está en juego, al Cómplice). La probabilidad no es fija: depende del tamaño de la sala (<strong style={{ color: '#fff' }}>del 65% con 5 agentes al 30% con 12</strong>) y aumenta con cada asesinato ya resuelto en la partida (<strong style={{ color: '#fff' }}>+10% por asesinato previo, máximo +25%</strong>) — la primera víctima es la más "limpia" y hacia el final de la partida la evidencia queda casi garantizada.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 6px 0', letterSpacing: '1px' }}>9. DESCUBRIMIENTO DE CUERPOS — EL DETALLE QUE IMPORTA</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                En el instante en que alguien encuentra con éxito un cuerpo <strong>oculto</strong> mediante Buscar Cuerpo, deja de estar oculto <strong>de forma permanente, por el resto de la partida</strong> — a partir de entonces, cualquiera que simplemente entre en esa sala (incluido un espectador que la esté viendo) lo verá sin necesidad de buscarlo, y nunca podrá volver a ocultarse. Todos los que alguna vez lo hayan visto quedan registrados como descubridores y aparecen después en el resumen del juicio. Mientras <strong>aunque solo sea un</strong> cuerpo en cualquier parte de la mansión permanezca sin descubrir, el terminal de salida de los Inocentes rechaza el código de plano, sea correcto o no — pero el juego nunca da pistas sobre quién falta ni dónde. Un jugador ejecutado por el consejo es el caso contrario: nunca se genera ningún cuerpo para él.
              </p>

              <p style={{ fontWeight: 'bold', color: '#bdef13', margin: '0 0 6px 0', letterSpacing: '1px' }}>10. RASTROS FORENSES EN LOS CUERPOS</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                En el instante en que se crea un cuerpo se le asigna exactamente un tipo de rastro fijo — grupo sanguíneo, categoría de altura o categoría de peso, de forma cíclica — que refleja las estadísticas reales del personaje del verdadero Asesino, de forma permanente desde ese momento. Solo el <strong>Forense</strong> puede extraerlo, mediante Examinar Cuerpo, únicamente durante el juicio, y solo en un cuerpo ya descubierto. Como un cuerpo solo revela una categoría, necesitas varios cuerpos distintos a lo largo de la partida para construir un perfil completo.
              </p>

              <p style={{ fontWeight: 'bold', color: '#00ff87', margin: '0 0 6px 0', letterSpacing: '1px' }}>11. PRUEBAS Y EL TABLERO COMPARTIDO DE PISTAS</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Los operativos recuperan huellas genuinas dejadas por accidente. El <strong>Cómplice</strong> puede manipular una prueba ya encontrada para incriminar a un jugador elegido — la falsificación desaparece deliberadamente <strong>del tablero compartido</strong> en el momento en que se altera, y solo sigue siendo visible para quien vuelva a registrar personalmente esa sala exacta. El <strong>Bromista</strong>, en cambio, planta pruebas deliberadamente asociadas a su propio personaje — esas sí se suman al tablero compartido una vez encontradas. Un cuerpo o pista encontrados nunca desaparecen ni «caducan» en una nueva ronda — permanecen visibles de forma permanente en esa sala y en el resumen. Si un jugador encuentra una prueba mediante Registrar Sala pero el <strong>Asesino</strong> lo mata esa misma ronda, su hallazgo se revierte — la prueba vuelve a quedar sin descubrir y permanece en esa sala hasta que otra persona la encuentre; si algún otro superviviente también la descubrió esa misma ronda, su hallazgo se mantiene.
              </p>

              <p style={{ fontWeight: 'bold', color: '#e040fb', margin: '0 0 6px 0', letterSpacing: '1px' }}>12. NEUROTOXINA-7</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Un número limitado de jeringas (1–3, según el tamaño de la sala) se esconden en salas aleatorias y se encuentran con un Registrar Sala normal. Solo el <strong>Asesino, el Cómplice y el Bromista</strong> pueden tocarla — es «demasiado peligrosa» para cualquier otro y se queda donde está. Solo se puede llevar una a la vez. Para el <strong>Asesino</strong> aumenta el límite de asesinatos a <strong style={{ color: '#fff' }}>dos por ronda</strong>, y se consume tras concretarse el segundo asesinato. Para el <strong>Cómplice/Bromista</strong> es un <strong>escudo pasivo</strong> que anula por completo el próximo ataque directo del Asesino y se consume al activarse — pero un intento fallido contra un objetivo protegido igualmente agota toda la <strong>capacidad de asesinato de esa ronda</strong> del Asesino, incluso si lleva su propia jeringa sin consumir. El escudo nunca protege contra una ejecución del consejo.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff9100', margin: '0 0 6px 0', letterSpacing: '1px' }}>13. TRAMPAS</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                El <strong>Cómplice</strong> puede preparar una sala con una trampa oculta (<strong style={{ color: '#fff' }}>1 cada 4 rondas</strong>). El primer agente de cualquier rol que entre en esa sala — con movimiento normal o salto de conducto — la activa al instante y la consume, y ese agente pierde todas sus acciones y habilidades durante toda su próxima ronda, tanto en la fase de acciones como en el juicio, incluido el terminal de salida. El Asesino recibe una notificación privada de dónde la colocó su Cómplice.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 8px 0', letterSpacing: '1px' }}>14. LOS ROLES ACTIVOS EN DETALLE</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 18px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#ff2a5f' }}>Asesino:</strong> neutraliza objetivos (<strong style={{ color: '#fff' }}>1/turno</strong>, 2 con Neurotoxina-7), luego decide el destino del cuerpo, y es el único con acceso a los conductos.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#ff9100' }}>Cómplice</strong> (8+ jugadores): puede manipular pruebas ya encontradas para incriminar a un jugador (<strong style={{ color: '#fff' }}>1 cada 3 turnos propios</strong>) e instalar una trampa (<strong style={{ color: '#fff' }}>1 cada 4 rondas</strong>). Se entera en privado de los descuidos del Asesino.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#00f0ff' }}>Detective:</strong> durante el juicio, revela en qué sala terminó su turno <em>anterior</em> un jugador elegido — congelado en el instante en que empieza el juicio (<strong style={{ color: '#fff' }}>1 cada 2 rondas</strong>). No puede elegirse a sí mismo. El resultado es privado para ti.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#2979ff' }}>Oficial:</strong> durante el juicio, programa que un sospechoso (o <em>a sí mismo</em>) quede encerrado en la Celda durante la <em>siguiente</em> ronda (<strong style={{ color: '#fff' }}>1 cada 3 rondas</strong>). Un jugador encerrado es completamente invisible para todos, incluidos los espectadores, y pierde todas sus acciones/habilidades durante toda la ronda.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#bdef13' }}>Forense</strong> (8+ jugadores): Verificar Autenticidad de Prueba (genuina o fabricada) O Examinar un Cuerpo en busca del rastro del Asesino — ambas comparten <strong style={{ color: '#fff' }}>una recarga de 1 ronda</strong>. Volver a revisar un cuerpo ya examinado es gratis — el informe queda guardado.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#e040fb' }}>Bromista</strong> (8+ jugadores): gana <em>solo</em> si el consejo lo ejecuta — nada más cuenta. Puede plantar pruebas personales en <em>cualquier</em> sala (<strong style={{ color: '#fff' }}>1 cada 2 turnos propios</strong>). El único rol al que se le permite votarse a sí mismo en el juicio.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#00ff87' }}>Inocente:</strong> sin poder ofensivo. Busca por la mansión los dígitos del código de anulación compartido y puede marcar anónimamente las salas revisadas (<strong style={{ color: '#fff' }}>1 cada 2 rondas</strong>). Solo los Inocentes pueden introducir el código para ganar.</li>
              </ul>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 6px 0', letterSpacing: '1px' }}>15. VOTACIÓN Y RESOLUCIÓN DEL JUICIO</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Cada jugador activo vota por un sospechoso concreto o por un <strong>Abstenerse</strong> explícito; nadie puede votarse a sí mismo excepto el Bromista. Un voto solo cuenta una vez confirmado, y se puede volver a confirmar libremente hasta que se agote el temporizador o todos hayan confirmado. Un candidato solo es ejecutado si tiene <strong>estrictamente más</strong> votos que nadie, sin empate en el primer puesto, y supera estrictamente al Abstenerse — de lo contrario, nadie es ejecutado esa ronda. Un jugador ejecutado no deja cuerpo.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ffeb3b', margin: '0 0 6px 0', letterSpacing: '1px' }}>16. CONDICIONES DE VICTORIA</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 18px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}>Un Inocente introduce el código correcto en el juicio sin cuerpos sin descubrir — <strong style={{ color: '#00ff87' }}>ganan los Inocentes</strong>.</li>
                <li style={{ marginBottom: '6px' }}>El consejo ejecuta al <strong style={{ color: '#ff2a5f' }}>Asesino</strong> — <strong style={{ color: '#00ff87' }}>victoria inmediata de los Inocentes</strong>, sin importar cuántos sobrevivan.</li>
                <li style={{ marginBottom: '6px' }}>El consejo ejecuta al <strong style={{ color: '#e040fb' }}>Bromista</strong> — el Bromista gana en solitario.</li>
                <li style={{ marginBottom: '6px' }}>Los jugadores pacíficos activos caen a un número igual o menor que el del equipo activo del Asesino (Asesino + Cómplice) — <strong style={{ color: '#ff2a5f' }}>victoria inmediata del equipo del Asesino</strong>. El Bromista queda excluido de ambos lados de este recuento.</li>
                <li style={{ marginBottom: '6px' }}>Todo el equipo del Asesino abandona la partida mientras quedan jugadores pacíficos — <strong style={{ color: '#00ff87' }}>ganan los Inocentes</strong> por defecto.</li>
              </ul>

              <p style={{ fontWeight: 'bold', color: '#9e9e9e', margin: '0 0 6px 0', letterSpacing: '1px' }}>17. PROTOCOLO ESPECTRO (FALLECIDOS)</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                La transmisión del terminal se corta, pero las anulaciones conceden <strong style={{ color: '#00ff87' }}>acceso ilimitado al mapa satelital</strong> — visión en vivo y libre de cualquier sala, pero sin poder actuar. El chat queda bloqueado para fallecidos/observadores específicamente durante la fase de juicio, y vuelve a abrirse fuera de ella.
              </p>

              <p style={{ fontWeight: 'bold', color: '#9e9e9e', margin: '0 0 6px 0', letterSpacing: '1px' }}>18. PEQUEÑOS DETALLES FÁCILES DE OLVIDAR</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 5px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}>Un dígito encontrado viene con su posición exacta en el código — el equipo lo ensambla en orden en lugar de adivinar.</li>
                <li style={{ marginBottom: '6px' }}>La pista accidental del Asesino puede caer en cualquier sala registrable, incluidas las que nadie ha visitado todavía.</li>
                <li style={{ marginBottom: '6px' }}>Las pruebas manipuladas por el Cómplice nunca aparecen en el tablero compartido — solo para quien vuelva a registrar personalmente esa sala.</li>
                <li style={{ marginBottom: '6px' }}>El Oficial puede encerrarse a <em>sí mismo</em> en la Celda — no hay ninguna regla que lo impida, a diferencia de la restricción del Detective de no poder elegirse a sí mismo.</li>
                <li style={{ marginBottom: '6px' }}>Las dos habilidades del Forense comparten una sola recarga — usar cualquiera de las dos pone ambas en recarga.</li>
                <li style={{ marginBottom: '6px' }}>El escudo de Neurotoxina-7 nunca protege contra un voto del consejo — solo contra el ataque directo del Asesino.</li>
                <li style={{ marginBottom: '6px' }}>Técnicamente, el servidor transmite la identidad del ocupante de la Celda a todos los clientes (no solo al Oficial), pero la interfaz nunca la muestra — solo se comprueba contra «¿soy yo?», así que en la práctica nadie salvo el jugador encerrado se entera de quién está dentro.</li>
                <li style={{ marginBottom: '6px' }}>Si nunca elegiste explícitamente un personaje pero marcaste Listo de todos modos con uno ya adjunto a esa solicitud, el servidor acepta silenciosamente el personaje que vino junto con el cambio a Listo.</li>
                <li style={{ marginBottom: '6px' }}>El texto de introducción solo se salta realmente cuando todos y cada uno de los jugadores han votado por saltarlo — no una mayoría.</li>
                <li style={{ marginBottom: '6px' }}>Mientras observas cualquier sala (como observador o jugador eliminado), tu vista se actualiza en tiempo real en cuanto algo cambia allí (se encuentra un cuerpo, se planta una prueba, entran o salen jugadores) — no hace falta volver a seleccionar la sala.</li>
                <li style={{ marginBottom: '6px' }}>El código de acceso de una sala privada es un código hexadecimal de 8 caracteres (letras y números, sin distinguir mayúsculas) — no un simple número.</li>
              </ul>
              </>
              ) : language === 'de' ? (
              <>
              <p style={{ fontWeight: 'bold', color: '#00f0ff', margin: '0 0 6px 0', letterSpacing: '1px' }}>1. LOBBY, CHARAKTERE & START</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Räume fassen <strong>5–12 Agenten</strong>. Jeder wählt einen von 12 einzigartigen Charakteren — kein Charakter kann doppelt vergeben werden, aber du kannst frei wechseln, bis du auf Bereit klickst. Der Host sperrt den Raum und startet die Vorbereitung über <strong>START OPERATION</strong>, danach schaltet jeder auf bereit. In dem Moment, in dem <strong>ausnahmslos alle</strong> bereit sind, startet automatisch ein <strong>5-Sekunden-Countdown</strong> — sobald jemand die Bereitschaft zurücknimmt, wird er sofort abgebrochen.
              </p>

              <p style={{ fontWeight: 'bold', color: '#00f0ff', margin: '0 0 6px 0', letterSpacing: '1px' }}>2. LADEN & ROLLENENTHÜLLUNG</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Der Einführungstext beginnt erst, wenn <strong>jeder Spieler</strong> sich als geladen gemeldet hat — bleibt ein Tab im Hintergrund hängen, wartet der Server <strong>15 Sekunden</strong> und startet dann trotzdem zwangsweise, damit niemand die Lobby blockieren kann. Deine Rolle wird genau in diesem Moment zugewiesen und <strong>nur dir</strong> offenbart — der Server sagt es niemandem sonst. Das Match selbst startet genauso: erst wenn alle bestätigt haben, den Rollenbildschirm fertig gesehen zu haben (gleiches 15-Sekunden-Sicherheitsnetz).
              </p>

              <p style={{ fontWeight: 'bold', color: '#ffeb3b', margin: '0 0 6px 0', letterSpacing: '1px' }}>3. ZÜGE & ZEIT</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Agenten handeln <strong>strikt der Reihe nach</strong>, und die Zugreihenfolge wird jede Runde neu gemischt (garantiert anders als in der Vorrunde). Jeder hat bis zu <strong>30 Sekunden</strong> — ein hartes serverseitiges Zeitlimit — um einen Sektor zum Durchsuchen zu wählen. Du hast <strong>genau eine Durchsuchung pro Zug</strong>, aber der Zug endet nicht automatisch, sobald du durchsuchst — du bleibst im Raum, bis du Zug beenden drückst oder die Zeit abläuft. Läuft die Zeit ab, ohne dass ein Raum gewählt wurde, wirst du trotzdem zufällig einem zugewiesen; läuft die Zeit nach der Raumwahl ab, endet der Zug einfach dort, wo du bist. Beides zieht keine Strafe nach sich. <strong style={{ color: '#fff' }}>Die Villenkarte ist immer nur für denjenigen sichtbar, der gerade am Zug ist</strong> — jeder andere lebende Agent sieht nur den Countdown und die generische Anzeige „EIN AGENT HANDELT", ohne Karte und ohne Möglichkeit, in irgendeinen Raum zu blicken, bis der eigene Zug kommt.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff9100', margin: '0 0 6px 0', letterSpacing: '1px' }}>4. ZWEI PHASEN PRO RUNDE</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                <strong>Aktionsphase:</strong> verdeckte Manöver und taktische Ausführung, bis jeder lebende Agent gezogen hat.<br />
                <strong>Prozessphase:</strong> ein kurzer Blackout (~1,5 s) → Fallankündigung mit Zusammenfassung der Erkenntnisse (~6 s) → Abstimmung (bis zu 120 s, endet früher, sobald alle festgelegt haben) → Auflösung (~3,5 s) → eine neue Runde oder das Spielende.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff9100', margin: '0 0 6px 0', letterSpacing: '1px' }}>5. LÜFTUNGSABKÜRZUNGEN</p>
              <p style={{ color: '#8a99ad', margin: '0 0 10px 0' }}>
                Nur der <strong>Mörder</strong> hat Zugang zu einem Netzwerk von Lüftungsschächten, die bestimmte Räume der Villa paarweise verbinden. Du musst bereits in einem stehen, um zu wechseln. Ein Wechsel geschieht sofort und kommt <strong>zusätzlich zu</strong> deiner normalen Durchsuchung, nicht anstelle davon, und setzt deine Raumoptionen im Zielraum zurück (einschließlich einer dort wartenden Falle). Es ist nur <strong>ein Schachtwechsel pro Zug</strong> erlaubt.
              </p>
              <p style={{ color: '#ff9100', margin: '0 0 6px 0', fontSize: '12px', letterSpacing: '0.5px', textTransform: 'uppercase' }}>Bekannte Schachtverbindungen:</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 18px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#fff' }}>Große Halle</strong> (1. Stock) ↔ <strong style={{ color: '#fff' }}>Hauptschlafzimmer</strong> (2. Stock)</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#fff' }}>Küche</strong> ↔ <strong style={{ color: '#fff' }}>Waffenkammer</strong> (beide 1. Stock)</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#fff' }}>Weinkeller</strong> (1. Stock) ↔ <strong style={{ color: '#fff' }}>Dachboden</strong> (2. Stock)</li>
              </ul>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Über die beiden durchsuchbaren Stockwerke hinaus (je 10 Räume) verfügt die Villa außerdem über eine verschlossene <strong style={{ color: '#fff' }}>Arrestzelle</strong> (1. Stock, untere rechte Ecke — nur relevant für die Fähigkeit des Offiziers) und eine <strong style={{ color: '#fff' }}>Folterkammer</strong> im Keller — rein atmosphärisch, aber wie jeder normale Raum begehbar.
              </p>

              <p style={{ fontWeight: 'bold', color: '#00ff87', margin: '0 0 6px 0', letterSpacing: '1px' }}>6. RAUMAKTIONEN: DURCHSUCHEN VS. NACH LEICHE SUCHEN</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Bei jedem Raumbesuch hast du genau <strong>eine</strong> von zwei Optionen — <strong>Raum durchsuchen</strong> oder <strong>Nach Leiche suchen</strong> — welche du zuerst wählst, sperrt die andere, bis du einen anderen Raum betrittst (eine neue Durchsuchung oder ein Schachtwechsel). Raum durchsuchen deckt auch das Finden platzierter Beweise oder einer dort liegenden Neurotoxin-7-Spritze ab — dafür gibt es keine separaten Schaltflächen.
              </p>

              <p style={{ fontWeight: 'bold', color: '#00ff87', margin: '0 0 6px 0', letterSpacing: '1px' }}>7. DER DIGITALE AUFHEBUNGSCODE</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Die Codelänge richtet sich nach der Anzahl der Unschuldigen in der Lobby: <strong style={{ color: '#fff' }}>4 Ziffern bei 1 Unschuldigem, +1 pro weiterem, maximal 10</strong>. Jede Ziffer ist für das gesamte Match in einem eigenen zufälligen Raum versteckt. Nur <strong>Unschuldige</strong> erhalten jemals eine echte Ziffer (samt genauer Position), wenn sie einen Raum durchsuchen, der eine enthält, und sobald das geschieht, wird das ganze Team sofort informiert — jede andere Rolle bekommt dasselbe leere Ergebnis, egal ob dort wirklich eine Ziffer liegt. Eine separate Fähigkeit <strong>Raum prüfen</strong> (<strong style={{ color: '#fff' }}>2-Runden-Abklingzeit</strong>, erfordert, dass der Raum in diesem Zug bereits durchsucht wurde) markiert einen Raum anonym als sauber für das gesamte Unschuldigen-Team — ein Raum, der tatsächlich eine Ziffer enthält, wird jedoch nie als sauber markiert, und diese Fähigkeit enthüllt niemals die Ziffer selbst.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 6px 0', letterSpacing: '1px' }}>8. LEICHE VERSTECKEN ODER OFFENLEGEN</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Direkt nach einem Mord muss der <strong>Mörder</strong> wählen: die Leiche <strong>verstecken</strong> — sie bleibt verborgen, bis jemand gezielt danach sucht, verbraucht dafür aber den Schachtwechsel dieses Zuges, also kein Schachtwechsel in dieser Runde — oder sie <strong>offenlegen</strong>, sodass sie für den nächsten Ankömmling frei sichtbar liegt, während der Schacht danach weiterhin nutzbar bleibt. Wird nie eine Entscheidung getroffen, legt der Server standardmäßig offen — eine Leiche geht nie stillschweigend verloren. Jeder Mord birgt außerdem eine Chance, dass der Mörder versehentlich einen Gegenstand des eigenen Charakters irgendwo zufällig in der Villa fallen lässt, nicht zwingend im Mordraum — nur der Mörder (und, falls im Spiel, der Komplize) erfährt davon. Die Chance ist nicht fix: Sie hängt von der Lobbygröße ab (<strong style={{ color: '#fff' }}>65 % bei 5 Agenten bis 30 % bei 12</strong>) und steigt mit jedem bereits abgeschlossenen Mord in diesem Match (<strong style={{ color: '#fff' }}>+10 % pro vorherigem Mord, maximal +25 %</strong>) — das erste Opfer ist das „sauberste", und gegen Spielende wird ein Beweis fast garantiert.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 6px 0', letterSpacing: '1px' }}>9. LEICHENFUND — DAS ENTSCHEIDENDE DETAIL</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                In dem Moment, in dem jemand erfolgreich eine <strong>versteckte</strong> Leiche durch Nach Leiche suchen findet, hört sie <strong>dauerhaft, für den Rest des Matches</strong>, auf, versteckt zu sein — von da an sieht jeder, der einfach in diesen Raum geht (auch ein Zuschauer, der hineinschaut), sie ohne weitere Suche, und sie kann nie wieder versteckt werden. Jeder, der sie jemals gesehen hat, wird als Finder geführt und erscheint später in der Prozess-Zusammenfassung. Solange <strong>auch nur eine einzige</strong> Leiche irgendwo in der Villa unentdeckt bleibt, verweigert das Ausgangsterminal der Unschuldigen den Code rundweg, ob richtig oder nicht — das Spiel gibt aber nie einen Hinweis, wer fehlt oder wo. Ein vom Rat hingerichteter Spieler ist der Gegenfall: Für ihn wird überhaupt nie eine Leiche erzeugt.
              </p>

              <p style={{ fontWeight: 'bold', color: '#bdef13', margin: '0 0 6px 0', letterSpacing: '1px' }}>10. FORENSISCHE SPUREN AN LEICHEN</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Sobald eine Leiche entsteht, wird ihr genau ein fester Spurentyp zugewiesen — Blutgruppe, Größenkategorie oder Gewichtskategorie, im Wechsel — der die tatsächlichen Charakterwerte des echten Mörders widerspiegelt, dauerhaft, ab diesem Moment. Nur der <strong>Kriminaltechniker</strong> kann sie auslesen, per Leiche untersuchen, nur während des Prozesses und nur bei einer bereits entdeckten Leiche. Da eine Leiche immer nur eine Kategorie preisgibt, braucht man mehrere verschiedene Leichen im Laufe des Matches, um ein vollständiges Profil zu erstellen.
              </p>

              <p style={{ fontWeight: 'bold', color: '#00ff87', margin: '0 0 6px 0', letterSpacing: '1px' }}>11. BEWEISE & DIE GEMEINSAME HINWEISTAFEL</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Agenten finden echte Spuren, die versehentlich hinterlassen wurden. Der <strong>Komplize</strong> kann einen bereits gefundenen Beweis fälschen, um einen ausgewählten Spieler zu belasten — die Fälschung <strong>verschwindet gezielt von der gemeinsamen Tafel</strong>, sobald sie verändert wird, und bleibt nur für denjenigen sichtbar, der genau diesen Raum persönlich erneut durchsucht. Der <strong>Joker</strong> dagegen platziert Beweise, die absichtlich nach seinem eigenen Charakter gestaltet sind — diese landen nach dem Fund tatsächlich auf der gemeinsamen Tafel. Eine gefundene Leiche oder ein Hinweis verschwindet nie und „verfällt" auch in einer neuen Runde nicht — er bleibt dauerhaft in diesem Raum und in der Zusammenfassung sichtbar. Findet ein Spieler einen Hinweis per Raum durchsuchen, wird aber in derselben Runde vom <strong>Mörder</strong> getötet, wird seine Fund-Gutschrift zurückgenommen — der Hinweis gilt wieder als unentdeckt und bleibt im Raum liegen, bis ihn jemand anderes findet; hat ein anderer überlebender Spieler ihn in derselben Runde ebenfalls entdeckt, bleibt dessen Gutschrift bestehen.
              </p>

              <p style={{ fontWeight: 'bold', color: '#e040fb', margin: '0 0 6px 0', letterSpacing: '1px' }}>12. NEUROTOXIN-7</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Eine begrenzte Anzahl an Spritzen (1–3, je nach Lobbygröße) ist in zufälligen Räumen versteckt und wird durch normales Raum durchsuchen gefunden. Nur <strong>Mörder, Komplize und Joker</strong> dürfen sie berühren — für alle anderen ist sie „zu gefährlich" und bleibt liegen. Es kann immer nur eine getragen werden. Für den <strong>Mörder</strong> erhöht sie das Tötungslimit auf <strong style={{ color: '#fff' }}>zwei pro Runde</strong>, verbraucht nach der zweiten gelungenen Tötung. Für <strong>Komplize/Joker</strong> ist sie ein <strong>passiver Schild</strong>, der den nächsten direkten Angriff des Mörders vollständig aufhebt und beim Auslösen verbraucht wird — ein gescheiterter Versuch gegen ein geschütztes Ziel verbraucht jedoch trotzdem die <strong>gesamte Tötungskapazität des Mörders für diese Runde</strong>, selbst wenn er seine eigene unverbrauchte Spritze bei sich trägt. Der Schild schützt nie vor einer Hinrichtung durch den Rat.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff9100', margin: '0 0 6px 0', letterSpacing: '1px' }}>13. FALLEN</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Der <strong>Komplize</strong> kann einen Raum mit einer versteckten Falle präparieren (<strong style={{ color: '#fff' }}>1 pro 4 Runden</strong>). Der erste Agent jeder Rolle, der diesen Raum betritt — normaler Zug oder Schachtwechsel — löst sie sofort aus und verbraucht sie, und dieser Agent verliert für seine gesamte nächste Runde jede Aktion und Fähigkeit, sowohl Aktionsphase als auch Prozess, einschließlich des Ausgangsterminals. Der Mörder wird privat darüber informiert, wo sein Komplize sie platziert hat.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 8px 0', letterSpacing: '1px' }}>14. AKTIVE ROLLEN IM DETAIL</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 18px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#ff2a5f' }}>Mörder:</strong> neutralisiert Ziele (<strong style={{ color: '#fff' }}>1/Zug</strong>, 2 mit Neurotoxin-7), entscheidet dann über das Schicksal der Leiche und hat als Einziger Zugang zu den Lüftungsschächten.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#ff9100' }}>Komplize</strong> (ab 8 Spielern): kann bereits gefundene Beweise fälschen, um einen Spieler zu belasten (<strong style={{ color: '#fff' }}>1 pro 3 eigene Züge</strong>), und eine Falle präparieren (<strong style={{ color: '#fff' }}>1 pro 4 Runden</strong>). Erfährt privat von den Patzern des Mörders.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#00f0ff' }}>Detektiv:</strong> enthüllt während des Prozesses, in welchem Raum ein gewählter Spieler seinen <em>vorherigen</em> Zug beendet hat — eingefroren in dem Moment, in dem der Prozess beginnt (<strong style={{ color: '#fff' }}>1 pro 2 Runden</strong>). Kann sich nicht selbst als Ziel wählen. Ergebnis ist nur für dich sichtbar.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#2979ff' }}>Offizier:</strong> plant während des Prozesses, einen Verdächtigen (oder <em>sich selbst</em>) für die <em>nächste</em> Runde in der Arrestzelle einzusperren (<strong style={{ color: '#fff' }}>1 pro 3 Runden</strong>). Ein eingesperrter Spieler ist für alle völlig unsichtbar, auch für Zuschauer, und verliert die ganze Runde über jede Aktion/Fähigkeit.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#bdef13' }}>Kriminaltechniker</strong> (ab 8 Spielern): Beweisechtheit prüfen (echt vs. gefälscht) ODER Leiche auf die Spur des Mörders untersuchen — beide teilen sich <strong style={{ color: '#fff' }}>eine Abklingzeit von 1 Runde</strong>. Eine bereits untersuchte Leiche erneut zu prüfen ist kostenlos — der Bericht ist zwischengespeichert.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#e040fb' }}>Joker</strong> (ab 8 Spielern): gewinnt <em>nur</em>, wenn er vom Rat hingerichtet wird — nichts anderes zählt. Kann in <em>jedem</em> Raum persönliche Beweise platzieren (<strong style={{ color: '#fff' }}>1 pro 2 eigene Züge</strong>). Die einzige Rolle, die beim Prozess für sich selbst stimmen darf.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#00ff87' }}>Unschuldiger:</strong> keine offensive Fähigkeit. Durchsucht die Villa nach den gemeinsamen Ziffern des Aufhebungscodes und kann geprüfte Räume anonym markieren (<strong style={{ color: '#fff' }}>1 pro 2 Runden</strong>). Nur Unschuldige können den Code zum Sieg eingeben.</li>
              </ul>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 6px 0', letterSpacing: '1px' }}>15. ABSTIMMUNG & PROZESSAUFLÖSUNG</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Jeder aktive Spieler stimmt für einen bestimmten Verdächtigen oder ausdrücklich für <strong>Überspringen</strong>; niemand darf für sich selbst stimmen außer dem Joker. Eine Stimme zählt erst, wenn sie festgelegt wurde, und kann frei geändert werden, bis der Timer abläuft oder alle festgelegt haben. Ein Kandidat wird nur hingerichtet, wenn er <strong>strikt die meisten</strong> Stimmen hat, es keinen Gleichstand um den ersten Platz gibt und er Überspringen strikt übertrifft — andernfalls wird in dieser Runde niemand hingerichtet. Ein hingerichteter Spieler hinterlässt keine Leiche.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ffeb3b', margin: '0 0 6px 0', letterSpacing: '1px' }}>16. SIEGBEDINGUNGEN</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 18px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}>Ein Unschuldiger gibt beim Prozess den richtigen Code ein, während keine Leiche unentdeckt bleibt — <strong style={{ color: '#00ff87' }}>Sieg der Unschuldigen</strong>.</li>
                <li style={{ marginBottom: '6px' }}>Der Rat richtet den <strong style={{ color: '#ff2a5f' }}>Mörder</strong> hin — sofortiger <strong style={{ color: '#00ff87' }}>Sieg der Unschuldigen</strong>, unabhängig von der Anzahl der Überlebenden.</li>
                <li style={{ marginBottom: '6px' }}>Der Rat richtet den <strong style={{ color: '#e040fb' }}>Joker</strong> hin — der Joker gewinnt allein.</li>
                <li style={{ marginBottom: '6px' }}>Die Zahl der aktiven friedlichen Spieler sinkt auf oder unter die Zahl des aktiven Mörder-Teams (Mörder + Komplize) — sofortiger <strong style={{ color: '#ff2a5f' }}>Sieg des Mörder-Teams</strong>. Der Joker zählt auf keiner Seite dieser Berechnung mit.</li>
                <li style={{ marginBottom: '6px' }}>Das gesamte Mörder-Team verlässt das Match, während friedliche Spieler übrig bleiben — standardmäßig <strong style={{ color: '#00ff87' }}>Sieg der Unschuldigen</strong>.</li>
              </ul>

              <p style={{ fontWeight: 'bold', color: '#9e9e9e', margin: '0 0 6px 0', letterSpacing: '1px' }}>17. GEISTER-PROTOKOLL (VERSTORBENE)</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Die Terminalübertragung ist unterbrochen, doch Freigaben gewähren einen <strong style={{ color: '#00ff87' }}>uneingeschränkten Satelliten-Kartenzugriff</strong> — freie Live-Ansicht jedes Raumes, aber keine Handlungen. Der Chat ist speziell während der Prozessphase für Verstorbene/Zuschauer gesperrt und außerhalb davon wieder offen.
              </p>

              <p style={{ fontWeight: 'bold', color: '#9e9e9e', margin: '0 0 6px 0', letterSpacing: '1px' }}>18. KLEINE DETAILS, DIE LEICHT VERGESSEN WERDEN</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 5px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}>Eine gefundene Ziffer kommt mit ihrer genauen Position im Code — das Team setzt ihn der Reihe nach zusammen, statt zu raten.</li>
                <li style={{ marginBottom: '6px' }}>Der versehentliche Hinweis des Mörders kann in jedem durchsuchbaren Raum landen, auch in noch nie besuchten.</li>
                <li style={{ marginBottom: '6px' }}>Vom Komplizen gefälschte Beweise erscheinen nie auf der gemeinsamen Tafel — nur für denjenigen, der diesen Raum persönlich erneut durchsucht.</li>
                <li style={{ marginBottom: '6px' }}>Der Offizier kann <em>sich selbst</em> in der Arrestzelle einsperren — dagegen besteht keine Regel, anders als bei der Selbstziel-Beschränkung des Detektivs.</li>
                <li style={{ marginBottom: '6px' }}>Die beiden Fähigkeiten des Kriminaltechnikers teilen sich eine Abklingzeit — die Nutzung der einen versetzt auch die andere in Abklingzeit.</li>
                <li style={{ marginBottom: '6px' }}>Der Neurotoxin-7-Schild schützt nie vor einer Ratsabstimmung — nur vor dem direkten Angriff des Mörders.</li>
                <li style={{ marginBottom: '6px' }}>Der Server überträgt die Identität des Arrestzellen-Insassen technisch an jeden Client (nicht nur den Offizier), aber die Oberfläche zeigt sie nie an — geprüft wird nur gegen „bin ich das?", sodass in der Praxis niemand außer dem Eingesperrten selbst erfährt, wer drin ist.</li>
                <li style={{ marginBottom: '6px' }}>Hast du nie ausdrücklich einen Charakter gewählt, aber trotzdem Bereit gedrückt mit einem bereits an diese Anfrage angehängten Charakter, akzeptiert der Server stillschweigend den Charakter, der mit dem Bereit-Umschalter mitkam.</li>
                <li style={{ marginBottom: '6px' }}>Der Einführungstext wird tatsächlich nur übersprungen, wenn wirklich jeder einzelne Spieler dafür gestimmt hat — keine Mehrheit.</li>
                <li style={{ marginBottom: '6px' }}>Beim Beobachten eines beliebigen Raumes (als Zuschauer oder eliminierter Spieler) aktualisiert sich deine Ansicht live in dem Moment, in dem sich dort etwas ändert (Leiche gefunden, Beweis platziert, Spieler betreten/verlassen den Raum) — der Raum muss nicht neu ausgewählt werden.</li>
                <li style={{ marginBottom: '6px' }}>Der Beitrittscode eines privaten Raums ist ein 8-stelliger Hex-Code (Buchstaben und Ziffern, Groß-/Kleinschreibung egal) — keine reine Zahl.</li>
              </ul>
              </>
              ) : language === 'fr' ? (
              <>
              <p style={{ fontWeight: 'bold', color: '#00f0ff', margin: '0 0 6px 0', letterSpacing: '1px' }}>1. SALON, PERSONNAGES ET LANCEMENT</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Les salons accueillent de <strong>5 à 12 agents</strong>. Chacun choisit l'un des 12 personnages uniques — deux joueurs ne peuvent pas avoir le même, mais vous pouvez changer librement jusqu'à ce que vous cliquiez sur Prêt. L'hôte verrouille le salon et lance la préparation via <strong>LANCER L'OPÉRATION</strong>, puis chacun bascule sur prêt. Dès l'instant où <strong>absolument tous les joueurs</strong> sont prêts, un <strong>compte à rebours de 5 secondes</strong> démarre automatiquement — si quelqu'un annule sa préparation, il est immédiatement interrompu.
              </p>

              <p style={{ fontWeight: 'bold', color: '#00f0ff', margin: '0 0 6px 0', letterSpacing: '1px' }}>2. CHARGEMENT ET RÉVÉLATION DU RÔLE</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Le texte d'introduction ne démarre que lorsque <strong>chaque joueur</strong> a signalé avoir fini de charger — si un onglet reste en arrière-plan et se bloque, le serveur attend <strong>15 secondes</strong> puis force le démarrage quand même, afin que personne ne puisse bloquer le salon. Votre rôle est attribué à cet instant précis et révélé <strong>uniquement à vous</strong> — le serveur ne le communique jamais à personne d'autre. La partie elle-même démarre de la même façon : uniquement lorsque tout le monde a confirmé avoir terminé de regarder l'écran de rôle (même filet de sécurité de 15 secondes).
              </p>

              <p style={{ fontWeight: 'bold', color: '#ffeb3b', margin: '0 0 6px 0', letterSpacing: '1px' }}>3. TOURS ET MINUTAGE</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Les agents agissent <strong>strictement à tour de rôle</strong>, et l'ordre des tours est redistribué à chaque round (garanti différent de celui du round précédent). Chaque agent dispose d'un maximum de <strong>30 secondes</strong> — une limite stricte côté serveur — pour choisir un secteur à fouiller. Vous avez droit à <strong>exactement une fouille par tour</strong>, mais le tour ne se termine pas automatiquement dès que vous fouillez — vous restez dans la pièce jusqu'à ce que vous terminiez votre tour ou que le temps s'écoule. Si le temps s'écoule sans que vous ayez choisi de pièce, vous êtes de toute façon placé au hasard dans l'une d'elles ; s'il s'écoule après que vous en avez choisi une, le tour se termine simplement là où vous êtes. Aucun des deux cas n'entraîne de pénalité. <strong style={{ color: '#fff' }}>La carte du manoir n'est jamais visible que par celui dont c'est actuellement le tour</strong> — tout autre agent vivant ne voit que le compte à rebours et la mention générique « UN AGENT AGIT », sans carte ni aucun moyen de jeter un œil dans une pièce, jusqu'à ce que son propre tour arrive.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff9100', margin: '0 0 6px 0', letterSpacing: '1px' }}>4. DEUX PHASES PAR ROUND</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                <strong>Phase d'action :</strong> manœuvres furtives et exécution tactique jusqu'à ce que chaque agent vivant ait joué.<br />
                <strong>Phase de procès :</strong> un bref black-out (~1,5 s) → annonce de l'affaire avec un récapitulatif des découvertes (~6 s) → vote (jusqu'à 120 s, se résout plus tôt si tout le monde a validé) → résolution (~3,5 s) → un nouveau round ou la fin de la partie.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff9100', margin: '0 0 6px 0', letterSpacing: '1px' }}>5. RACCOURCIS DE VENTILATION</p>
              <p style={{ color: '#8a99ad', margin: '0 0 10px 0' }}>
                Seul le <strong>Tueur</strong> peut accéder à un réseau de conduits d'aération reliant certaines pièces du manoir deux par deux. Vous devez déjà vous trouver dans l'une d'elles pour pouvoir basculer. Un basculement est instantané et <strong>s'ajoute à</strong> votre fouille normale, sans la remplacer, et réinitialise les options de la pièce de destination (y compris un éventuel piège qui y attend). <strong>Un seul basculement de conduit est autorisé par tour</strong>.
              </p>
              <p style={{ color: '#ff9100', margin: '0 0 6px 0', fontSize: '12px', letterSpacing: '0.5px', textTransform: 'uppercase' }}>Connexions de conduits connues :</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 18px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#fff' }}>Grand Hall</strong> (1er étage) ↔ <strong style={{ color: '#fff' }}>Chambre principale</strong> (2e étage)</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#fff' }}>Cuisine</strong> ↔ <strong style={{ color: '#fff' }}>Armurerie</strong> (toutes deux au 1er étage)</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#fff' }}>Cave à vin</strong> (1er étage) ↔ <strong style={{ color: '#fff' }}>Grenier</strong> (2e étage)</li>
              </ul>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Au-delà des deux étages fouillables (10 pièces chacun), le manoir comprend aussi une <strong style={{ color: '#fff' }}>Cellule de détention</strong> verrouillée (1er étage, coin inférieur droit — pertinente uniquement pour la capacité de l'Officier) et une <strong style={{ color: '#fff' }}>Salle de torture</strong> au sous-sol — purement atmosphérique, mais praticable comme n'importe quelle pièce normale.
              </p>

              <p style={{ fontWeight: 'bold', color: '#00ff87', margin: '0 0 6px 0', letterSpacing: '1px' }}>6. ACTIONS EN PIÈCE : ENQUÊTER OU CHERCHER UN CORPS</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Chaque visite de pièce vous donne exactement <strong>une</strong> des deux options — <strong>Enquêter sur la pièce</strong> ou <strong>Chercher un corps</strong> — celle que vous choisissez en premier verrouille l'autre jusqu'à ce que vous entriez dans une autre pièce (une nouvelle fouille ou un saut de conduit). Enquêter sur la pièce permet aussi de trouver toute preuve plantée ou une seringue de Neurotoxine-7 qui s'y trouverait — il n'y a pas de boutons séparés pour cela.
              </p>

              <p style={{ fontWeight: 'bold', color: '#00ff87', margin: '0 0 6px 0', letterSpacing: '1px' }}>7. LE CODE DE REMPLACEMENT NUMÉRIQUE</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                La longueur du code dépend du nombre d'Innocents présents dans le salon : <strong style={{ color: '#fff' }}>4 chiffres pour 1 Innocent, +1 par Innocent supplémentaire, avec un maximum de 10</strong>. Chaque chiffre est caché pour toute la partie dans une pièce aléatoire qui lui est propre. Seuls les <strong>Innocents</strong> peuvent obtenir un vrai chiffre (avec sa position exacte) en enquêtant sur une pièce qui en contient un, et dès que cela arrive, toute l'équipe en est informée instantanément — tout autre rôle obtient le même résultat vide, qu'un chiffre s'y trouve réellement ou non. Une capacité distincte, <strong>Vérifier la pièce</strong> (<strong style={{ color: '#fff' }}>recharge de 2 rounds</strong>, nécessite que la pièce ait déjà été fouillée ce tour-ci), marque anonymement une pièce comme propre pour toute l'équipe des Innocents — mais une pièce qui contient réellement un chiffre n'est jamais marquée comme propre, et cette capacité ne révèle jamais le chiffre lui-même.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 6px 0', letterSpacing: '1px' }}>8. CACHER OU EXPOSER LE CORPS</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Juste après un meurtre, le <strong>Tueur</strong> doit choisir : <strong>Cacher</strong> le corps — il reste dissimulé jusqu'à ce que quelqu'un le cherche délibérément, mais cela consomme le saut de conduit de ce tour, donc pas de conduit ce tour-là — ou l'<strong>Exposer</strong>, le laissant bien visible pour le prochain arrivant, tout en gardant le conduit disponible ensuite. Si aucune décision n'est prise, le serveur choisit par défaut de l'exposer — un corps n'est jamais silencieusement perdu. Chaque meurtre comporte aussi une chance que le Tueur laisse accidentellement tomber un objet de son propre personnage quelque part au hasard dans le manoir, pas nécessairement dans la pièce du meurtre — seul le Tueur (et, s'il est en jeu, le Complice) en est informé. Cette chance n'est pas fixe : elle dépend de la taille du salon (<strong style={{ color: '#fff' }}>65 % à 5 agents jusqu'à 30 % à 12</strong>) et augmente avec chaque meurtre déjà commis dans cette partie (<strong style={{ color: '#fff' }}>+10 % par meurtre précédent, plafonné à +25 %</strong>) — la première victime est la « plus propre », et une preuve devient presque garantie en fin de partie.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 6px 0', letterSpacing: '1px' }}>9. DÉCOUVERTE DU CORPS — LE DÉTAIL QUI COMPTE</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Dès qu'un corps <strong>caché</strong> est retrouvé avec succès grâce à Chercher un corps, il cesse d'être caché <strong>de façon permanente, pour le reste de la partie</strong> — à partir de là, quiconque entre simplement dans cette pièce (y compris un spectateur qui y jette un œil) le voit sans avoir besoin de chercher, et il ne peut plus jamais être recaché. Tous ceux qui l'ont déjà vu sont crédités comme découvreurs et apparaissent plus tard dans le récapitulatif du procès. Tant que <strong>ne serait-ce qu'un seul</strong> corps reste non découvert quelque part dans le manoir, le terminal de sortie des Innocents refuse catégoriquement le code, qu'il soit correct ou non — mais le jeu ne donne jamais d'indice sur qui manque ni où. Un joueur exécuté par le conseil est le cas inverse : aucun corps n'est jamais généré pour lui.
              </p>

              <p style={{ fontWeight: 'bold', color: '#bdef13', margin: '0 0 6px 0', letterSpacing: '1px' }}>10. TRACES MÉDICO-LÉGALES SUR LES CORPS</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Dès qu'un corps est créé, il se voit attribuer exactement un type de trace fixe — groupe sanguin, catégorie de taille ou catégorie de poids, en alternance — reflétant les statistiques réelles du personnage du véritable Tueur, de façon permanente, à partir de cet instant. Seul le <strong>Criminaliste</strong> peut l'extraire, via Examiner le corps, uniquement pendant le procès, et uniquement sur un corps déjà découvert. Comme un corps ne révèle jamais qu'une seule catégorie, il faut plusieurs corps différents au cours de la partie pour établir un profil complet.
              </p>

              <p style={{ fontWeight: 'bold', color: '#00ff87', margin: '0 0 6px 0', letterSpacing: '1px' }}>11. PREUVES ET LE TABLEAU D'INDICES PARTAGÉ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Les agents récupèrent de véritables indices laissés par accident. Le <strong>Complice</strong> peut falsifier une preuve déjà trouvée pour incriminer un joueur choisi — le faux <strong>disparaît délibérément du tableau partagé</strong> dès qu'il est modifié, ne restant visible que pour celui qui enquête personnellement à nouveau sur cette pièce précise. Le <strong>Joker</strong>, à l'inverse, plante des preuves délibérément conçues à l'image de son propre personnage — celles-ci rejoignent réellement le tableau partagé une fois trouvées. Un corps ou un indice trouvé ne disparaît jamais et n'« expire » jamais lors d'un nouveau round — il reste visible en permanence dans cette pièce et dans le récapitulatif. Si un joueur trouve un indice en Enquêtant sur la pièce mais que le <strong>Tueur</strong> le tue ce même round, son crédit de découverte est annulé — l'indice redevient non découvert et reste dans la pièce jusqu'à ce que quelqu'un d'autre le trouve ; si un autre joueur survivant l'a également découvert ce même round, son crédit à lui reste acquis.
              </p>

              <p style={{ fontWeight: 'bold', color: '#e040fb', margin: '0 0 6px 0', letterSpacing: '1px' }}>12. NEUROTOXINE-7</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Un nombre limité de seringues (1 à 3, selon la taille du salon) sont cachées dans des pièces aléatoires et se trouvent via un Enquêter sur la pièce normal. Seuls le <strong>Tueur, le Complice et le Joker</strong> peuvent la toucher — elle est « trop dangereuse » pour tous les autres et reste sur place. Une seule peut être transportée à la fois. Pour le <strong>Tueur</strong>, elle porte la limite de meurtres à <strong style={{ color: '#fff' }}>deux par round</strong>, consommée après le deuxième meurtre réussi. Pour le <strong>Complice/Joker</strong>, c'est un <strong>bouclier passif</strong> qui annule entièrement la prochaine attaque directe du Tueur et se consomme lors de son déclenchement — mais une tentative échouée sur une cible protégée consomme quand même <strong>toute la capacité de meurtre du Tueur pour ce round entier</strong>, même s'il porte sa propre seringue non consommée. Le bouclier ne protège jamais contre une exécution du conseil.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff9100', margin: '0 0 6px 0', letterSpacing: '1px' }}>13. PIÈGES</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Le <strong>Complice</strong> peut piéger une pièce avec un piège caché (<strong style={{ color: '#fff' }}>1 tous les 4 rounds</strong>). Le premier agent, quel que soit son rôle, qui entre dans cette pièce — déplacement normal ou saut de conduit — le déclenche instantanément et le consomme, et cet agent perd toute action et capacité pour l'intégralité de son prochain round, aussi bien la phase d'action que le procès, y compris le terminal de sortie. Le Tueur est informé en privé de l'endroit où son Complice l'a posé.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 8px 0', letterSpacing: '1px' }}>14. RÔLES ACTIFS EN DÉTAIL</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 18px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#ff2a5f' }}>Tueur :</strong> neutralise des cibles (<strong style={{ color: '#fff' }}>1/tour</strong>, 2 avec la Neurotoxine-7), décide ensuite du sort du corps, et est le seul à avoir accès aux conduits.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#ff9100' }}>Complice</strong> (8 joueurs et plus) : peut falsifier une preuve déjà trouvée pour incriminer un joueur (<strong style={{ color: '#fff' }}>1 tous les 3 de ses propres tours</strong>) et poser un piège (<strong style={{ color: '#fff' }}>1 tous les 4 rounds</strong>). Apprend en privé les erreurs du Tueur.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#00f0ff' }}>Détective :</strong> pendant le procès, révèle dans quelle pièce un joueur choisi a terminé son tour <em>précédent</em> — figé à l'instant où le procès commence (<strong style={{ color: '#fff' }}>1 tous les 2 rounds</strong>). Ne peut pas se cibler lui-même. Le résultat n'est visible que par vous.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#2979ff' }}>Officier :</strong> pendant le procès, programme l'enfermement d'un suspect (ou de <em>vous-même</em>) dans la Cellule de détention pour le round <em>suivant</em> (<strong style={{ color: '#fff' }}>1 tous les 3 rounds</strong>). Un joueur enfermé est totalement invisible pour tout le monde, y compris les spectateurs, et perd toute action/capacité pendant tout le round.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#bdef13' }}>Criminaliste</strong> (8 joueurs et plus) : Vérifier l'authenticité d'une preuve (authentique ou fabriquée) OU Examiner un corps pour trouver la trace du Tueur — les deux partagent <strong style={{ color: '#fff' }}>une seule recharge, d'un round</strong>. Réexaminer un corps déjà examiné est gratuit — le rapport est mis en cache.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#e040fb' }}>Joker</strong> (8 joueurs et plus) : ne gagne <em>que</em> s'il est exécuté par le conseil — rien d'autre ne compte. Peut planter des preuves personnelles dans <em>n'importe quelle</em> pièce (<strong style={{ color: '#fff' }}>1 tous les 2 de ses propres tours</strong>). Le seul rôle autorisé à voter pour lui-même au procès.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#00ff87' }}>Innocent :</strong> aucun pouvoir offensif. Fouille le manoir à la recherche des chiffres du code de remplacement partagé et peut marquer anonymement les pièces vérifiées (<strong style={{ color: '#fff' }}>1 tous les 2 rounds</strong>). Seuls les Innocents peuvent soumettre le code pour gagner.</li>
              </ul>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 6px 0', letterSpacing: '1px' }}>15. VOTE ET RÉSOLUTION DU PROCÈS</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Chaque joueur actif vote pour un suspect précis ou explicitement pour <strong>Passer</strong> ; personne ne peut voter pour soi-même, sauf le Joker. Un vote ne compte qu'une fois validé, et peut être librement changé tant que le temps n'est pas écoulé ou que tout le monde n'a pas validé. Un candidat n'est exécuté que s'il a <strong>strictement le plus</strong> de voix, sans égalité pour la première place, et qu'il devance strictement Passer — sinon, personne n'est exécuté ce round-là. Un joueur exécuté ne laisse aucun corps.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ffeb3b', margin: '0 0 6px 0', letterSpacing: '1px' }}>16. CONDITIONS DE VICTOIRE</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 18px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}>Un Innocent soumet le bon code pendant le procès sans qu'aucun corps ne reste non découvert — <strong style={{ color: '#00ff87' }}>victoire des Innocents</strong>.</li>
                <li style={{ marginBottom: '6px' }}>Le conseil exécute le <strong style={{ color: '#ff2a5f' }}>Tueur</strong> — <strong style={{ color: '#00ff87' }}>victoire immédiate des Innocents</strong>, quel que soit le nombre de survivants.</li>
                <li style={{ marginBottom: '6px' }}>Le conseil exécute le <strong style={{ color: '#e040fb' }}>Joker</strong> — le Joker gagne seul.</li>
                <li style={{ marginBottom: '6px' }}>Le nombre de joueurs pacifiques actifs descend au niveau ou en dessous de celui de l'équipe active du Tueur (Tueur + Complice) — <strong style={{ color: '#ff2a5f' }}>victoire immédiate de l'équipe du Tueur</strong>. Le Joker n'est compté d'aucun côté de ce calcul.</li>
                <li style={{ marginBottom: '6px' }}>Toute l'équipe du Tueur quitte la partie alors que des joueurs pacifiques restent — <strong style={{ color: '#00ff87' }}>victoire des Innocents</strong> par défaut.</li>
              </ul>

              <p style={{ fontWeight: 'bold', color: '#9e9e9e', margin: '0 0 6px 0', letterSpacing: '1px' }}>17. PROTOCOLE SPECTRE (DÉFUNTS)</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                La transmission du terminal est coupée, mais les autorisations accordent un <strong style={{ color: '#00ff87' }}>accès illimité au flux satellite de la carte</strong> — vue en direct et libre de n'importe quelle pièce, mais sans possibilité d'agir. Le chat est verrouillé pour les défunts/observateurs spécifiquement pendant la phase de procès, et se rouvre en dehors de celle-ci.
              </p>

              <p style={{ fontWeight: 'bold', color: '#9e9e9e', margin: '0 0 6px 0', letterSpacing: '1px' }}>18. PETITS DÉTAILS FACILES À OUBLIER</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 5px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}>Un chiffre trouvé vient avec sa position exacte dans le code — l'équipe l'assemble dans l'ordre au lieu de deviner.</li>
                <li style={{ marginBottom: '6px' }}>L'indice accidentel du Tueur peut atterrir dans n'importe quelle pièce fouillable, y compris celles que personne n'a encore visitées.</li>
                <li style={{ marginBottom: '6px' }}>Les preuves falsifiées par le Complice n'apparaissent jamais sur le tableau partagé — seulement pour celui qui enquête personnellement à nouveau sur cette pièce.</li>
                <li style={{ marginBottom: '6px' }}>L'Officier peut s'enfermer <em>lui-même</em> dans la Cellule de détention — rien ne l'interdit, contrairement à la restriction du Détective qui ne peut pas se cibler lui-même.</li>
                <li style={{ marginBottom: '6px' }}>Les deux capacités du Criminaliste partagent une seule recharge — utiliser l'une met aussi l'autre en recharge.</li>
                <li style={{ marginBottom: '6px' }}>Le bouclier de Neurotoxine-7 ne protège jamais contre un vote du conseil — seulement contre l'attaque directe du Tueur.</li>
                <li style={{ marginBottom: '6px' }}>Le serveur diffuse techniquement l'identité de l'occupant de la Cellule de détention à chaque client (pas seulement à l'Officier), mais l'interface ne l'affiche jamais — elle vérifie seulement « est-ce moi ? », donc en pratique, personne à part le joueur enfermé lui-même n'apprend qui est à l'intérieur.</li>
                <li style={{ marginBottom: '6px' }}>Si vous n'avez jamais explicitement choisi de personnage mais que vous avez quand même cliqué sur Prêt avec un personnage déjà attaché à cette requête, le serveur accepte silencieusement le personnage qui accompagnait le basculement vers Prêt.</li>
                <li style={{ marginBottom: '6px' }}>Le texte d'introduction n'est réellement passé que lorsque absolument tous les joueurs ont voté pour le passer — pas une majorité.</li>
                <li style={{ marginBottom: '6px' }}>En observant n'importe quelle pièce (en tant que spectateur ou joueur éliminé), votre vue se met à jour en direct dès que quelque chose y change (un corps trouvé, une preuve plantée, des joueurs qui entrent ou sortent) — inutile de resélectionner la pièce.</li>
                <li style={{ marginBottom: '6px' }}>Le code d'accès d'un salon privé est un code hexadécimal à 8 caractères (lettres et chiffres, insensible à la casse) — pas un simple nombre.</li>
              </ul>
              </>
              ) : (
              <>
              <p style={{ fontWeight: 'bold', color: '#00f0ff', margin: '0 0 6px 0', letterSpacing: '1px' }}>1. LOBBY, CHARACTERS & LAUNCH</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Rooms hold <strong>5–12 agents</strong>. Each picks one of 12 unique characters — no two players can hold the same one, but you can freely swap until you hit Ready. The host locks the room and enters preparation via <strong>START OPERATION</strong>, then everyone toggles ready. The instant <strong>every single player</strong> is ready, a <strong>5-second countdown</strong> starts automatically — anyone un-readying cancels it immediately.
              </p>

              <p style={{ fontWeight: 'bold', color: '#00f0ff', margin: '0 0 6px 0', letterSpacing: '1px' }}>2. LOADING & ROLE REVEAL</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                The intro text only starts once <strong>every player</strong> has reported in as loaded — if a tab is backgrounded and stalls, the server waits <strong>15 seconds</strong> then force-starts anyway, so nobody can soft-lock the lobby. Your role is assigned at that exact moment and revealed <strong>only to you</strong> — the server never tells anyone else. The match itself starts the same way: only once everyone has confirmed they finished watching the role screen (same 15-second safety net).
              </p>

              <p style={{ fontWeight: 'bold', color: '#ffeb3b', margin: '0 0 6px 0', letterSpacing: '1px' }}>3. TURNS & TIMING</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Agents operate <strong>strictly in sequence</strong>, and the turn order is reshuffled every round (guaranteed different from last round's). Each asset has up to <strong>30 seconds</strong> — a hard server-side timer — to pick a sector to search. You get <strong>exactly one search per turn</strong>, but the turn doesn't auto-end the moment you search — you stay in the room until you End Turn or the clock runs out. Time out without ever picking a room and you're randomly dropped into one anyway; time out after picking one and the turn simply ends where you are. Neither carries a penalty. <strong style={{ color: '#fff' }}>The mansion map is only ever visible to whoever's turn it currently is</strong> — every other living agent just sees the countdown and a generic "AN AGENT IS ACTING" label, with no map and no way to peek any room, until their own turn comes up.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff9100', margin: '0 0 6px 0', letterSpacing: '1px' }}>4. TWO PHASES PER ROUND</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                <strong>Action Phase:</strong> ghost maneuvers and tactical execution until every living agent has moved.<br />
                <strong>Trial Phase:</strong> a brief blackout (~1.5s) → case announcement with a findings recap (~6s) → voting (up to 120s, resolves early once everyone's locked in) → resolution (~3.5s) → a new round or game over.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff9100', margin: '0 0 6px 0', letterSpacing: '1px' }}>5. VENTILATION SHORTCUTS</p>
              <p style={{ color: '#8a99ad', margin: '0 0 10px 0' }}>
                The <strong>Killer</strong> alone can access a network of vent shortcuts linking specific mansion rooms in pairs. You must already be standing in one to hop. A hop is instant and comes <strong>on top of</strong> your normal search, not instead of it, and re-arms your room options in the destination (including any waiting trap there). Only <strong>one vent hop is allowed per turn</strong>.
              </p>
              <p style={{ color: '#ff9100', margin: '0 0 6px 0', fontSize: '12px', letterSpacing: '0.5px', textTransform: 'uppercase' }}>Known vent connections:</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 18px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#fff' }}>Grand Hall</strong> (1st floor) ↔ <strong style={{ color: '#fff' }}>Master Bedroom</strong> (2nd floor)</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#fff' }}>Kitchen</strong> ↔ <strong style={{ color: '#fff' }}>Armory</strong> (both 1st floor)</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#fff' }}>Wine Cellar</strong> (1st floor) ↔ <strong style={{ color: '#fff' }}>Attic</strong> (2nd floor)</li>
              </ul>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Beyond the two searchable floors (10 rooms each), the mansion also has a locked <strong style={{ color: '#fff' }}>Holding Cell</strong> (1st floor, bottom-right corner — only relevant to the Officer's ability) and a basement <strong style={{ color: '#fff' }}>Torture Room</strong> — purely atmospheric, but walkable like any normal room.
              </p>

              <p style={{ fontWeight: 'bold', color: '#00ff87', margin: '0 0 6px 0', letterSpacing: '1px' }}>6. ROOM ACTIONS: INVESTIGATE VS. SEARCH FOR BODY</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Each room visit gives you exactly <strong>one</strong> of two options — <strong>Investigate Room</strong> or <strong>Search for Body</strong> — whichever you pick first locks out the other until you enter a different room (a fresh search or a vent hop). Investigate Room also handles finding any planted evidence or a Neurotoxin-7 syringe sitting there — no separate buttons for those.
              </p>

              <p style={{ fontWeight: 'bold', color: '#00ff87', margin: '0 0 6px 0', letterSpacing: '1px' }}>7. THE DIGITAL OVERRIDE CODE</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Code length scales with the number of Innocents in the lobby: <strong style={{ color: '#fff' }}>4 digits for 1 Innocent, +1 per additional one, capped at 10</strong>. Each digit is hidden in its own random room for the whole match. Only <strong>Innocents</strong> ever get a real digit (plus its exact position) from Investigating a room that has one, and the moment one does, the whole team is told instantly — every other role gets the identical empty result whether or not a digit is really there. A separate <strong>Check Room</strong> ability (<strong style={{ color: '#fff' }}>2-round cooldown</strong>, requires that room to already be investigated this turn) anonymously marks a room clean for the whole Innocent team — but a room that genuinely holds a digit is never marked clean, and this ability never reveals the digit itself.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 6px 0', letterSpacing: '1px' }}>8. HIDE OR EXPOSE THE BODY</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Right after a kill, the <strong>Killer</strong> must choose: <strong>Hide</strong> the body — it stays concealed until someone deliberately searches for it, but this uses up the turn's vent hop, so no venting that turn — or <strong>Expose</strong> it, leaving it in plain sight for whoever walks in next, while still keeping the vent free to use afterward. If the decision is never made, the server defaults to Expose — a body is never silently lost. Every kill also carries a chance the Killer accidentally drops one of their own character's items somewhere random in the mansion, not necessarily the murder room — only the Killer (and, if in play, the Accomplice) is ever told. The chance isn't fixed: it depends on lobby size (<strong style={{ color: '#fff' }}>65% at 5 agents down to 30% at 12</strong>) and climbs with every kill already resolved this match (<strong style={{ color: '#fff' }}>+10% per prior kill, capped at +25%</strong>) — the first victim is the "cleanest" and evidence becomes almost guaranteed by the endgame.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 6px 0', letterSpacing: '1px' }}>9. BODY DISCOVERY — THE DETAIL THAT MATTERS</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                The instant anyone successfully finds a <strong>hidden</strong> body via Search for Body, it stops being hidden <strong>permanently, for the rest of the match</strong> — from then on anyone who simply walks into that room (including a spectator peeking it) sees it with no search required, and it can never be re-hidden. Everyone who's ever laid eyes on it is credited as a finder and shows up later in the Trial recap. As long as <strong>even one</strong> body anywhere in the mansion remains undiscovered, the Innocents' exit terminal refuses the code outright, correct or not — but the game never hints who's missing or where. A council-executed player is the opposite case: no body is ever generated for them at all.
              </p>

              <p style={{ fontWeight: 'bold', color: '#bdef13', margin: '0 0 6px 0', letterSpacing: '1px' }}>10. FORENSIC TRACES ON BODIES</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                The instant a body is created it's assigned exactly one fixed trace type — blood type, height category, or weight category, cycling — reflecting the real Killer's actual character stats, permanently, from that moment on. Only the <strong>Forensic Examiner</strong> can pull it out, via Examine Body, only during Trial, and only on an already-discovered body. Since one body only ever reveals one category, you need several different bodies over the match to build a full profile.
              </p>

              <p style={{ fontWeight: 'bold', color: '#00ff87', margin: '0 0 6px 0', letterSpacing: '1px' }}>11. EVIDENCE & THE SHARED CLUES BOARD</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Operatives recover genuine footprints left by accident. The <strong>Accomplice</strong> can doctor an already-found piece of evidence to frame a chosen player — the fake deliberately <strong>vanishes from the shared board</strong> the moment it's altered, staying visible only to whoever personally re-investigates that exact room. The <strong>Joker</strong>, by contrast, plants evidence deliberately styled after their own character — those genuinely join the shared board once found. A found body or clue never disappears or "expires" on a new round — it stays permanently viewable in that room and in the recap. If a player finds a clue via Investigate Room but the <strong>Killer</strong> kills them that same round, their discovery credit is reverted — the clue drops back to undiscovered and stays sitting in the room until someone else finds it; if another surviving player also discovered it that same round, their credit still stands.
              </p>

              <p style={{ fontWeight: 'bold', color: '#e040fb', margin: '0 0 6px 0', letterSpacing: '1px' }}>12. NEUROTOXIN-7</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                A limited number of syringes (1–3, scaled to lobby size) are hidden in random rooms and found via a normal Investigate Room. Only the <strong>Killer, Accomplice, and Joker</strong> may touch it — it's "too hazardous" for anyone else and stays put. Only one can be carried at a time. For the <strong>Killer</strong> it raises the kill limit to <strong style={{ color: '#fff' }}>two per round</strong>, consumed after the second kill lands. For the <strong>Accomplice/Joker</strong> it's a <strong>passive shield</strong> that fully negates the Killer's next direct attack and is consumed on trigger — but a failed attempt on a shielded target still burns the Killer's <strong>entire round's</strong> kill capacity, even if they're carrying their own unconsumed syringe. The shield never protects against a council execution.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff9100', margin: '0 0 6px 0', letterSpacing: '1px' }}>13. TRAPS</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                The <strong>Accomplice</strong> can rig a room with a hidden trap (<strong style={{ color: '#fff' }}>1 per 4 rounds</strong>). The first agent of any role who walks into that room — normal move or vent hop — sets it off instantly and consumes it, and that agent loses every action and ability for their entire next round, action phase and Trial alike, including the exit terminal. The Killer is privately notified where their Accomplice set it.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 8px 0', letterSpacing: '1px' }}>14. ACTIVE ROLES IN DEPTH</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 18px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#ff2a5f' }}>Killer:</strong> neutralizes targets (<strong style={{ color: '#fff' }}>1/turn</strong>, 2 with Neurotoxin-7), then decides the body's fate, and alone has vent access.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#ff9100' }}>Accomplice</strong> (8+ players): can doctor already-found evidence to frame a player (<strong style={{ color: '#fff' }}>1 per 3 own turns</strong>) and rig a trap (<strong style={{ color: '#fff' }}>1 per 4 rounds</strong>). Privately learns of the Killer's slip-ups.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#00f0ff' }}>Detective:</strong> during Trial, reveals which room a chosen player ended their <em>previous</em> turn in — frozen the instant Trial begins (<strong style={{ color: '#fff' }}>1 per 2 rounds</strong>). Can't target yourself. Result is private to you.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#2979ff' }}>Officer:</strong> during Trial, schedules a suspect (or <em>yourself</em>) to be locked in the Holding Cell for the <em>next</em> round (<strong style={{ color: '#fff' }}>1 per 3 rounds</strong>). A locked player is completely invisible to everyone, including spectators, and loses every action/ability all round.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#bdef13' }}>Forensic</strong> (8+ players): Verify Evidence Authenticity (genuine vs. fabricated) OR Examine a Body for the Killer's trace — both share <strong style={{ color: '#fff' }}>one cooldown, 1 round</strong>. Re-checking an already-examined body is free — the report is cached.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#e040fb' }}>Joker</strong> (8+ players): wins <em>only</em> if executed by council — nothing else counts. Can plant personal evidence in <em>any</em> room (<strong style={{ color: '#fff' }}>1 per 2 own turns</strong>). The only role allowed to vote for itself at Trial.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#00ff87' }}>Innocent:</strong> no offensive power. Searches the mansion for the shared override code digits and can anonymously mark checked rooms (<strong style={{ color: '#fff' }}>1 per 2 rounds</strong>). Only Innocents can submit the code to win.</li>
              </ul>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 6px 0', letterSpacing: '1px' }}>15. VOTING & TRIAL RESOLUTION</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Every active player votes for a specific suspect or an explicit <strong>Skip</strong>; nobody can vote for themselves except the Joker. A vote only counts once locked in, and can be freely relocked until the timer runs out or everyone's locked. A candidate is only executed if they have <strong>strictly the most</strong> votes, with no tie for first, and strictly beat Skip — otherwise nobody is executed that round. An executed player leaves no body.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ffeb3b', margin: '0 0 6px 0', letterSpacing: '1px' }}>16. WIN CONDITIONS</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 18px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}>An Innocent submits the correct code at Trial with no undiscovered bodies — <strong style={{ color: '#00ff87' }}>Innocents win</strong>.</li>
                <li style={{ marginBottom: '6px' }}>The council executes the <strong style={{ color: '#ff2a5f' }}>Killer</strong> — immediate <strong style={{ color: '#00ff87' }}>Innocent victory</strong>, regardless of survivor count.</li>
                <li style={{ marginBottom: '6px' }}>The council executes the <strong style={{ color: '#e040fb' }}>Joker</strong> — the Joker wins solo.</li>
                <li style={{ marginBottom: '6px' }}>Active peaceful players drop to at or below the active Killer-team count (Killer + Accomplice) — immediate <strong style={{ color: '#ff2a5f' }}>Killer-team victory</strong>. The Joker is excluded from both sides of this count.</li>
                <li style={{ marginBottom: '6px' }}>The entire Killer team leaves the match while peaceful players remain — <strong style={{ color: '#00ff87' }}>Innocents win</strong> by default.</li>
              </ul>

              <p style={{ fontWeight: 'bold', color: '#9e9e9e', margin: '0 0 6px 0', letterSpacing: '1px' }}>17. SPECTER PROTOCOL (DECEASED)</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Terminal transmission cut off, but overrides grant <strong style={{ color: '#00ff87' }}>Unrestricted Satellite Map Feed</strong> — free-roam live viewing of any room, but no acting. Chat is locked for the deceased/observers specifically during the Trial phase, and open again outside it.
              </p>

              <p style={{ fontWeight: 'bold', color: '#9e9e9e', margin: '0 0 6px 0', letterSpacing: '1px' }}>18. SMALL DETAILS EASY TO FORGET</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 5px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}>A found digit comes with its exact position in the code — the team assembles it in order rather than guessing.</li>
                <li style={{ marginBottom: '6px' }}>The Killer's accidental clue can land in any searchable room, including ones nobody's visited yet.</li>
                <li style={{ marginBottom: '6px' }}>Evidence the Accomplice has doctored never appears on the shared board — only to whoever personally re-investigates that room.</li>
                <li style={{ marginBottom: '6px' }}>The Officer can lock <em>themselves</em> in the Holding Cell — no rule against it, unlike the Detective's self-target restriction.</li>
                <li style={{ marginBottom: '6px' }}>The Forensic Examiner's two abilities share one cooldown — using either puts both on cooldown.</li>
                <li style={{ marginBottom: '6px' }}>The Neurotoxin-7 shield never protects against a council vote — only against the Killer's direct attack.</li>
                <li style={{ marginBottom: '6px' }}>The server technically broadcasts the Holding Cell occupant's identity to every client (not just the Officer), but the interface never displays it — it's only ever checked against "is this me?", so in practice nobody but the confined player learns who's inside.</li>
                <li style={{ marginBottom: '6px' }}>If you never explicitly picked a character but hit Ready anyway with one already attached to that request, the server silently accepts whichever character came along with the Ready toggle.</li>
                <li style={{ marginBottom: '6px' }}>The intro text only actually skips once every single player has voted to skip it — not a majority.</li>
                <li style={{ marginBottom: '6px' }}>While spectating any room (as an observer or eliminated player), your view updates live the instant something changes there (a body found, evidence planted, players entering/leaving) — no need to re-select the room.</li>
                <li style={{ marginBottom: '6px' }}>A private room's join code is an 8-character hex code (letters and digits, case-insensitive) — not a plain number.</li>
              </ul>
              </>
              )}
            </div>

            <NeonButton variant="secondary" style={{ marginTop: '15px', flexShrink: 0 }} onClick={() => setCurrentScreen('main')}><Icon name="arrowLeft" size={13} style={{ marginRight: 6 }} />{t('back')}</NeonButton>
          </div>
        )}

      </main>
    </div>
      )}

      {/* --- GAME SCREEN: black background, intro text, role, gameplay --- */}
      {isNicknameSet && currentScreen === 'game' && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: '#000',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 5,
          overflow: 'hidden'
        }}>

          {/* --- DOPAMINE CORNER: looping muted video, only visible during other
               players' turns (action phase, not your own turn). The <video>
               stays mounted and playing continuously the whole time this
               setting is on and we're on the game screen — only its
               visibility toggles with the turn, so there's no re-fetch /
               re-decode delay each time it's supposed to appear. Click to
               minimize into a small tab; click the tab to bring it back. --- */}
          {dopamineCorner && (() => {
            const dopamineCornerVisible = displayPhase === 'action' && currentTurnPlayerId && currentTurnPlayerId !== socket.id;
            return (
              <>
                <div
                  onClick={() => setDopamineCornerMinimized(false)}
                  role="button"
                  aria-label={language === 'ru' ? 'Развернуть дофаминовый уголок' : language === 'uk' ? "Розгорнути дофаміновий куточок" : language === 'es' ? 'Expandir el rincón de dopamina' : language === 'de' ? 'Dopamin-Ecke erweitern' : language === 'fr' ? 'Agrandir le coin dopamine' : 'Expand Dopamine Corner'}
                  style={{
                    position: 'fixed',
                    // Left corner (moved from the right). Nudged down when the
                    // Neurotoxin-7 carrier badge is also occupying the top-left
                    // slot, so the two never overlap.
                    top: neurotoxinCarried ? '64px' : '16px',
                    left: '16px',
                    zIndex: 9500,
                    padding: '8px 12px',
                    borderRadius: '8px',
                    background: 'rgba(18, 18, 28, 0.9)',
                    border: '1px solid rgba(0, 240, 255, 0.4)',
                    boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                    color: '#00f0ff',
                    fontSize: '11px',
                    fontWeight: 'bold',
                    letterSpacing: '1px',
                    cursor: 'pointer',
                    userSelect: 'none',
                    opacity: dopamineCornerVisible && dopamineCornerMinimized ? 1 : 0,
                    pointerEvents: dopamineCornerVisible && dopamineCornerMinimized ? 'auto' : 'none',
                    transition: 'opacity 0.15s ease'
                  }}
                >
                  ▶ {language === 'ru' ? 'ДОФАМИНОВЫЙ УГОЛОК' : language === 'uk' ? "ДОФАМІНОВИЙ КУТОЧОК" : language === 'es' ? 'RINCÓN DE DOPAMINA' : language === 'de' ? 'DOPAMIN-ECKE' : language === 'fr' ? 'COIN DOPAMINE' : 'DOPAMINE CORNER'}
                </div>
                <img
                  ref={dopamineCornerVideoRef}
                  src={DOPAMINE_CORNER_VIDEO}
                  alt=""
                  onClick={() => setDopamineCornerMinimized(true)}
                  aria-label={language === 'ru' ? 'Свернуть дофаминовый уголок' : language === 'uk' ? "Згорнути дофаміновий куточок" : language === 'es' ? 'Minimizar el rincón de dopamina' : language === 'de' ? 'Dopamin-Ecke minimieren' : language === 'fr' ? 'Réduire le coin dopamine' : 'Minimize Dopamine Corner'}
                  style={{
                    position: 'fixed',
                    // Left corner (moved from the right), same neurotoxin-badge
                    // collision offset as the minimized tab above.
                    top: neurotoxinCarried ? '64px' : '16px',
                    left: '16px',
                    zIndex: 9500,
                    width: 'clamp(120px, 20vw, 340px)',
                    height: 'auto',
                    borderRadius: '10px',
                    border: '1px solid rgba(0, 240, 255, 0.4)',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.6), 0 0 20px rgba(0,240,255,0.15)',
                    cursor: 'pointer',
                    display: 'block',
                    opacity: dopamineCornerVisible && !dopamineCornerMinimized ? 1 : 0,
                    pointerEvents: dopamineCornerVisible && !dopamineCornerMinimized ? 'auto' : 'none',
                    transition: 'opacity 0.15s ease'
                  }}
                />
              </>
            );
          })()}

          {/* Waiting for other players to load */}
          {gamePhase === 'loading' && (
            <p style={{
              color: '#8a99ad',
              fontSize: '13px',
              letterSpacing: '3px',
              textTransform: 'uppercase',
              animation: 'introCaretBlink 1.6s ease-in-out infinite'
            }}>
              {language === 'ru' ? 'Установка защищённого канала...' : language === 'uk' ? "Встановлення захищеного каналу..." : language === 'es' ? 'Estableciendo canal seguro...' : language === 'de' ? 'Sicherer Kanal wird aufgebaut...' : language === 'fr' ? 'Établissement du canal sécurisé...' : 'Establishing secure channel...'}
            </p>
          )}

          {/* Intro text with a typewriter effect */}
          {gamePhase === 'intro' && (
            <div style={{
              maxWidth: '720px',
              width: '90%',
              padding: '20px',
              opacity: introFadingOut ? 0 : 1,
              transition: 'opacity 0.9s ease-in-out'
            }}>
              <p style={{
                fontSize: '17px',
                lineHeight: '1.9',
                color: '#c9d3e0',
                whiteSpace: 'pre-wrap',
                fontFamily: 'Georgia, serif',
                textShadow: '0 0 12px rgba(255,255,255,0.05)'
              }}>
                {introTypedText}
                {!introFinished && (
                  <span style={{
                    display: 'inline-block',
                    width: '9px',
                    height: '18px',
                    background: '#00f0ff',
                    marginLeft: '2px',
                    verticalAlign: 'text-bottom',
                    animation: 'introCaretBlink 1s steps(1) infinite'
                  }} />
                )}
              </p>

              {/* SKIP button in the bottom-right corner — requires a unanimous vote */}
              {!introFinished && (
                <div style={{ position: 'fixed', right: '24px', bottom: `${24 + bottomInset}px`, textAlign: 'right' }}>
                  {skipVotes.total > 0 && (
                    <div style={{ fontSize: '10px', color: '#8a99ad', letterSpacing: '1px', marginBottom: '6px' }}>
                      {skipVotes.count}/{skipVotes.total} {language === 'ru' ? 'ПРОГОЛОСОВАЛИ ЗА ПРОПУСК' : language === 'uk' ? "ПРОГОЛОСУВАЛИ ЗА ПРОПУСК" : language === 'es' ? 'VOTARON POR SALTAR' : language === 'de' ? 'STIMMTEN FÜR ÜBERSPRINGEN' : language === 'fr' ? 'A VOTÉ POUR PASSER' : 'VOTED TO SKIP'}
                    </div>
                  )}
                  <button
                    onClick={handleSkipVote}
                    disabled={hasVotedSkip}
                    style={{
                      background: hasVotedSkip ? 'rgba(0,255,135,0.08)' : 'rgba(255,255,255,0.04)',
                      border: hasVotedSkip ? '1px solid #00ff87' : '1px solid rgba(255,255,255,0.2)',
                      color: hasVotedSkip ? '#00ff87' : '#aaa',
                      padding: '10px 18px',
                      borderRadius: '6px',
                      fontSize: '11px',
                      fontWeight: 'bold',
                      letterSpacing: '2px',
                      textTransform: 'uppercase',
                      cursor: hasVotedSkip ? 'default' : 'pointer'
                    }}
                  >
                    {language === 'ru'
                      ? (hasVotedSkip ? 'ГОЛОС ОТДАН' : 'ПРОПУСТИТЬ ▸')
                      : language === 'uk'
                      ? (hasVotedSkip ? 'ГОЛОС ВІДДАНО' : 'ПРОПУСТИТИ ▸')
                      : language === 'es'
                      ? (hasVotedSkip ? 'VOTO EMITIDO' : 'SALTAR ▸')
                      : language === 'de'
                      ? (hasVotedSkip ? 'STIMME ABGEGEBEN' : 'ÜBERSPRINGEN ▸')
                      : (hasVotedSkip ? 'VOTE CAST' : 'SKIP ▸')}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Role reveal: edge glow -> sprite -> label -> fade into gameplay */}
          {gamePhase === 'role' && (
            <>
              {!activeRoleData && (
                <p style={{
                  color: '#8a99ad',
                  fontSize: '13px',
                  letterSpacing: '3px',
                  textTransform: 'uppercase',
                  animation: 'introCaretBlink 1.6s ease-in-out infinite'
                }}>
                  {language === 'ru' ? 'Расшифровка личности...' : language === 'uk' ? "Розшифрування особи..." : language === 'es' ? 'Descifrando identidad...' : language === 'de' ? 'Identität wird entschlüsselt...' : language === 'fr' ? "Déchiffrement de l'identité..." : 'Decrypting identity...'}
                </p>
              )}

              {activeRoleData && (
                // Fade-out of the whole reveal block (glow + sprite + label)
                // ROLE_REVEAL_HOLD_MS after the label appears — see the useEffect
                // above. Once the fade finishes, the client signals
                // 'role_reveal_done'; gameplay ('playing') starts once every
                // player in the room has done so.
                <div style={{ opacity: roleFadingOut ? 0 : 1, transition: `opacity ${ROLE_REVEAL_FADE_MS}ms ease-in-out` }}>
                  {/* Edge glow in the role's color */}
                  <div style={{
                    position: 'absolute',
                    inset: 0,
                    boxShadow: `inset 0 0 160px 40px ${activeRoleData.color}`,
                    opacity: roleRevealStage === 'hidden' ? 0 : 0.55,
                    transition: 'opacity 1.4s ease-in-out',
                    pointerEvents: 'none'
                  }} />

                  <div style={{ textAlign: 'center', zIndex: 1, padding: '20px' }}>
                    {(roleRevealStage === 'sprite' || roleRevealStage === 'label') && (
                      <img
                        src={activeRoleData.sprite}
                        alt={language === 'ru' ? activeRoleData.labelRu : language === 'uk' ? activeRoleData.labelUk : language === 'es' ? activeRoleData.labelEs : language === 'de' ? activeRoleData.labelDe : language === 'fr' ? activeRoleData.labelFr : activeRoleData.label}
                        style={{
                          width: '220px',
                          height: '220px',
                          objectFit: 'cover',
                          borderRadius: '14px',
                          border: `2px solid ${activeRoleData.color}`,
                          boxShadow: `0 0 40px ${activeRoleData.color}`,
                          animation: 'roleSpriteIn 0.7s ease-out',
                          marginBottom: '22px'
                        }}
                      />
                    )}

                    {roleRevealStage === 'label' && (
                      <div style={{ animation: 'roleLabelIn 0.8s ease-out forwards' }}>
                        <h2 style={{
                          fontSize: '32px',
                          fontWeight: '900',
                          letterSpacing: '4px',
                          color: activeRoleData.color,
                          textShadow: `0 0 22px ${activeRoleData.color}`,
                          margin: '0 0 12px 0',
                          fontFamily: 'Georgia, serif',
                          fontStyle: 'italic'
                        }}>
                          {language === 'ru' ? activeRoleData.labelRu : language === 'uk' ? activeRoleData.labelUk : language === 'es' ? activeRoleData.labelEs : language === 'de' ? activeRoleData.labelDe : language === 'fr' ? activeRoleData.labelFr : activeRoleData.label}
                        </h2>
                        <p style={{
                          maxWidth: '380px',
                          margin: '0 auto',
                          fontSize: '13px',
                          lineHeight: '1.6',
                          color: '#bdc7db',
                          letterSpacing: '0.5px'
                        }}>
                          {language === 'ru' ? activeRoleData.descriptionRu : language === 'uk' ? activeRoleData.descriptionUk : language === 'es' ? activeRoleData.descriptionEs : language === 'de' ? activeRoleData.descriptionDe : language === 'fr' ? activeRoleData.descriptionFr : activeRoleData.description}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Gameplay: round, turn order, 30s turn countdown, mansion map */}
          {gamePhase === 'playing' && (
            <div style={{
              textAlign: 'center',
              color: '#e2e8f0',
              padding: '20px',
              width: '90%',
              maxWidth: currentTurnPlayerId === socket.id && displayPhase === 'action' ? '620px' : '600px',
              maxHeight: '92vh',
              overflowY: 'auto'
            }}>
              {/* Evidence HUD: digits found via INVESTIGATE ROOM (shared across the
                  whole Innocent team — see 'investigate_result'), positioned by their
                  place in the code. Persists on screen for the whole match — it is
                  never cleared on turn/round transitions, only ever added to. This is
                  the ONE place the code fragments are shown; keep it that way. */}
              {foundFragments.length > 0 && (
                <div style={{
                  position: 'fixed',
                  top: '18px',
                  right: '18px',
                  zIndex: 40,
                  padding: '10px 14px',
                  borderRadius: '12px',
                  border: '1px solid rgba(0,255,135,0.3)',
                  background: 'rgba(6, 10, 8, 0.82)',
                  backdropFilter: 'blur(8px)',
                  textAlign: 'right',
                  boxShadow: '0 10px 30px rgba(0,0,0,0.35)'
                }}>
                  <p style={{ margin: '0 0 6px 0', fontSize: '10px', letterSpacing: '2px', color: '#8a99ad' }}>
                    {language === 'ru' ? 'КОД ОТМЕНЫ' : language === 'uk' ? "КОД СКАСУВАННЯ" : language === 'es' ? 'CÓDIGO DE ANULACIÓN' : language === 'de' ? 'AUFHEBUNGSCODE' : language === 'fr' ? 'CODE DE REMPLACEMENT' : 'OVERRIDE CODE'}
                  </p>
                  <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                    {Array.from({ length: codeTotalDigits || foundFragments.length }, (_, i) => {
                      const found = foundFragments.find(f => f.position === i + 1);
                      return (
                        <div key={i} style={{
                          width: '26px',
                          height: '32px',
                          borderRadius: '6px',
                          border: `1px solid ${found ? 'rgba(0,255,135,0.5)' : 'rgba(255,255,255,0.15)'}`,
                          background: found ? 'rgba(0,255,135,0.12)' : 'rgba(255,255,255,0.03)',
                          color: found ? '#00ff87' : '#4b5568',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '16px',
                          fontWeight: 800,
                          fontFamily: 'Georgia, serif'
                        }}>
                          {found ? found.digit : '?'}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* --- NEUROTOXIN-7 PICKUP POPUP: centered, replaces the toast for
                   a successful pickup only (failed attempts still toast). Click
                   anywhere on the backdrop to dismiss early, or it auto-closes. --- */}
              {neurotoxinPopup && (
                <div
                  onClick={dismissNeurotoxinPopup}
                  role="button"
                  aria-label={language === 'ru' ? 'Закрыть' : language === 'uk' ? "Закрити" : language === 'es' ? 'Cerrar' : language === 'de' ? 'Schließen' : language === 'fr' ? 'Ignorer' : 'Dismiss'}
                  style={{
                    position: 'fixed',
                    inset: 0,
                    zIndex: 9600,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'rgba(0, 0, 0, 0.45)',
                    backdropFilter: 'blur(2px)',
                    cursor: 'pointer',
                    animation: 'trialCardEnter 220ms cubic-bezier(0.16, 1, 0.3, 1)'
                  }}
                >
                  <div
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '26px 32px',
                      borderRadius: '16px',
                      border: '1px solid rgba(163, 255, 90, 0.45)',
                      background: 'rgba(8, 14, 8, 0.96)',
                      boxShadow: '0 20px 60px rgba(0,0,0,0.6), 0 0 40px rgba(163,255,90,0.15)',
                      maxWidth: 'min(320px, calc(100vw - 40px))',
                      textAlign: 'center'
                    }}
                  >
                    <div style={{
                      width: '52px',
                      height: '52px',
                      borderRadius: '50%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'rgba(163, 255, 90, 0.12)',
                      border: '1px solid rgba(163, 255, 90, 0.4)'
                    }}>
                      <Icon name="flask" size={24} color="#a3ff5a" />
                    </div>
                    <p style={{ margin: 0, fontSize: '11px', letterSpacing: '2px', color: '#a3ff5a', fontWeight: 'bold' }}>
                      {language === 'ru' ? 'НЕЙРОТОКСИН-7' : language === 'uk' ? "НЕЙРОТОКСИН-7" : language === 'es' ? 'NEUROTOXINA-7' : language === 'de' ? 'NEUROTOXIN-7' : language === 'fr' ? 'NEUROTOXINE-7' : 'NEUROTOXIN-7'}
                    </p>
                    <p style={{ margin: 0, fontSize: '14px', lineHeight: 1.5, color: '#e2e8f0' }}>
                      {neurotoxinPopup.message}
                    </p>
                  </div>
                </div>
              )}

              {/* --- NEUROTOXIN-7 CARRIER BADGE: persistent top-left indicator
                   while the player holds an unconsumed dose (cleared once both
                   charges are used or the shield is triggered — see
                   setNeurotoxinCarried callers). --- */}
              {neurotoxinCarried && (
                <div style={{
                  position: 'fixed',
                  top: '16px',
                  left: '16px',
                  zIndex: 9500,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '8px 14px',
                  borderRadius: '10px',
                  background: 'rgba(8, 14, 8, 0.9)',
                  border: '1px solid rgba(163, 255, 90, 0.4)',
                  boxShadow: '0 4px 16px rgba(0,0,0,0.5), 0 0 16px rgba(163,255,90,0.12)',
                  color: '#a3ff5a',
                  fontSize: '11px',
                  fontWeight: 'bold',
                  letterSpacing: '1px'
                }}>
                  <Icon name="flask" size={14} />
                  <span>{language === 'ru' ? 'НЕЙРОТОКСИН-7' : language === 'uk' ? "НЕЙРОТОКСИН-7" : language === 'es' ? 'NEUROTOXINA-7' : language === 'de' ? 'NEUROTOXIN-7' : language === 'fr' ? 'NEUROTOXINE-7' : 'NEUROTOXIN-7'}</span>
                </div>
              )}

              {/* Transient toasts for investigate_room results ("useless trash",
                  "nothing of interest", and the fragment confirmation itself). */}
              {toasts.length > 0 && (
                <div style={{
                  position: 'fixed',
                  bottom: `${18 + bottomInset}px`,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  zIndex: 50,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                  alignItems: 'center'
                }}>
                  {toasts.map(t => (
                    <div
                      key={t.id}
                      onClick={() => dismissToast(t.id)}
                      style={{
                        padding: '10px 18px',
                        borderRadius: '999px',
                        border: '1px solid rgba(255,255,255,0.15)',
                        background: 'rgba(10, 12, 18, 0.92)',
                        color: '#e2e8f0',
                        fontSize: '13px',
                        letterSpacing: '0.3px',
                        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                        cursor: 'pointer',
                        animation: t.leaving
                          ? 'toastExit 320ms cubic-bezier(0.4, 0, 1, 1) forwards'
                          : 'trialCardEnter 260ms cubic-bezier(0.16, 1, 0.3, 1)'
                      }}
                    >
                      {t.message}
                    </div>
                  ))}
                </div>
              )}

              <p style={{ fontSize: '11px', letterSpacing: '2px', color: '#8a99ad', marginBottom: '6px' }}>
                {language === 'ru'
                  ? `РАУНД ${gameData.round} ${displayPhase === 'trial' ? '— СУД' : '— ФАЗА ДЕЙСТВИЙ'}`
                  : language === 'uk' ? `РАУНД ${gameData.round} ${displayPhase === 'trial' ? '— СУД' : '— ФАЗА ДІЙ'}` : language === 'es' ? `RONDA ${gameData.round} ${displayPhase === 'trial' ? '— JUICIO' : '— FASE DE ACCIONES'}` : language === 'de' ? `RUNDE ${gameData.round} ${displayPhase === 'trial' ? '— PROZESS' : '— AKTIONSPHASE'}` : language === 'fr' ? `ROUND ${gameData.round} ${displayPhase === 'trial' ? '— PROCÈS' : "— PHASE D'ACTION"}` : `ROUND ${gameData.round} ${displayPhase === 'trial' ? '— TRIAL' : '— ACTION PHASE'}`}
              </p>

              {/* --- HOLDING CELL: ROUND-LONG SPECTATOR VIEW ---------------------
                  Whoever the Officer confined here (see isLockedInHoldingCell,
                  derived from the public `lockedInHoldingCell` state set on
                  'round_start' / 'phase_state') sees ONLY this for the entire
                  round's action phase — regardless of whose turn is actually
                  active. No timer, no mansion map, no room actions: their own
                  "turn" is auto-skipped server-side with no countdown at all
                  (see startPlayerTurn / onTurnStart's `skipped` early-return). */}
              {displayPhase === 'action' && isLockedInHoldingCell && (
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '18px',
                  padding: '10px 0 4px'
                }}>
                  <h2 style={{ fontSize: '22px', letterSpacing: '2px', color: '#e0524a', marginBottom: 0 }}>
                    {language === 'ru' ? 'ЗАПЕРТЫ В КАМЕРЕ' : language === 'uk' ? "ЗАМКНЕНІ В КАМЕРІ" : language === 'es' ? 'ENCERRADO EN LA CELDA' : language === 'de' ? 'IN DER ZELLE EINGESPERRT' : language === 'fr' ? 'ENFERMÉ DANS LA CELLULE DE DÉTENTION' : 'LOCKED IN THE HOLDING CELL'}
                  </h2>
                  <p style={{ margin: 0, maxWidth: '420px', fontSize: '12px', lineHeight: 1.6, color: '#c9a5a2', letterSpacing: '0.3px' }}>
                    {language === 'ru'
                      ? 'Офицер запер вас здесь на весь этот раунд. Вы не можете двигаться, обыскивать комнаты или действовать — дождитесь начала следующего раунда.'
                      : language === 'uk' ? "Офіцер замкнув вас тут на весь цей раунд. Ви не можете рухатися, обшукувати кімнати чи діяти — зачекайте на початок наступного раунду." : language === 'es' ? 'El Oficial te ha encerrado aquí durante toda esta ronda. No puedes moverte, registrar salas ni actuar — espera a que empiece la siguiente ronda.' : language === 'de' ? 'Der Offizier hat dich für diese gesamte Runde hier eingesperrt. Du kannst dich nicht bewegen, keine Räume durchsuchen und nicht handeln — warte auf den Beginn der nächsten Runde.' : language === 'fr' ? "L'Agent de police vous a confiné(e) ici pour la totalité de ce round. Vous ne pouvez ni bouger, ni fouiller, ni agir — patientez jusqu'au début du round suivant." : 'The Officer has confined you here for the entirety of this round. You cannot move, search, or act — sit tight until the next round begins.'}
                  </p>

                  <div style={{
                    width: 'min(420px, 100%)',
                    height: '260px',
                    borderRadius: '18px',
                    border: '1px solid rgba(224,82,74,0.35)',
                    background: ROOM_INTERIORS.f1_holding_cell?.gradient || 'linear-gradient(160deg, #241010 0%, #120808 100%)',
                    boxShadow: 'inset 0 0 90px rgba(0,0,0,0.5), 0 0 40px rgba(224,82,74,0.12)',
                    position: 'relative',
                    overflow: 'hidden'
                  }}>
                    {/* Deliberately always rendered with NO occupants — nobody
                        confined to the Holding Cell, including the viewer
                        themself, is ever shown as an avatar/model here (see
                        the server's activeRoomOccupants, which always returns
                        an empty list for f1_holding_cell). */}
                    <RoomVisualScene
                      roomId="f1_holding_cell"
                      accent={ROOM_INTERIORS.f1_holding_cell?.accent || '#e0524a'}
                      occupants={[]}
                      bodies={[]}
                    />
                  </div>

                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '8px 14px',
                    borderRadius: '999px',
                    border: '1px solid rgba(224,82,74,0.35)',
                    background: 'rgba(224,82,74,0.08)',
                    color: '#ff9caf',
                    fontSize: '11px',
                    letterSpacing: '1px',
                    fontWeight: 800
                  }}>
                    <Icon name="lock" size={13} color="#ff9caf" />
                    {language === 'ru' ? 'ДЕЙСТВИЯ В ЭТОМ РАУНДЕ НЕДОСТУПНЫ' : language === 'uk' ? "ДІЇ В ЦЬОМУ РАУНДІ НЕДОСТУПНІ" : language === 'es' ? 'ACCIONES NO DISPONIBLES ESTA RONDA' : language === 'de' ? 'KEINE AKTIONEN IN DIESER RUNDE VERFÜGBAR' : language === 'fr' ? 'AUCUNE ACTION DISPONIBLE CE ROUND' : 'NO ACTIONS AVAILABLE THIS ROUND'}
                  </div>
                </div>
              )}

              {displayPhase === 'action' && !isLockedInHoldingCell && currentTurnPlayerId && (
                <>
                  <h2 style={{
                    fontSize: '22px',
                    letterSpacing: '2px',
                    color: currentTurnPlayerId === socket.id ? '#00ff87' : '#00f0ff',
                    marginBottom: '18px'
                  }}>
                    {currentTurnPlayerId === socket.id
                      ? (language === 'ru' ? 'ВАШ ХОД' : language === 'uk' ? "ВАШ ХІД" : language === 'es' ? 'TU TURNO' : language === 'de' ? 'DU BIST AM ZUG' : language === 'fr' ? 'VOTRE TOUR' : 'YOUR TURN')
                      // Deliberately not revealing which player is acting — only the
                      // player themself should know whose turn it is.
                      : (language === 'ru' ? 'АГЕНТ ДЕЙСТВУЕТ' : language === 'uk' ? "АГЕНТ ДІЄ" : language === 'es' ? 'UN AGENTE ACTÚA' : language === 'de' ? 'EIN AGENT HANDELT' : language === 'fr' ? 'UN AGENT AGIT' : 'AN AGENT IS ACTING')}
                  </h2>

                  <div style={{
                    fontSize: '48px',
                    fontWeight: 900,
                    color: turnTimeLeft <= 5 ? '#ff2a5f' : '#00f0ff',
                    textShadow: `0 0 30px ${turnTimeLeft <= 5 ? 'rgba(255,42,95,0.6)' : 'rgba(0,240,255,0.6)'}`,
                    fontFamily: 'Georgia, serif',
                    marginBottom: '18px'
                  }}>
                    {turnTimeLeft}s
                  </div>
                  <div aria-label={language === 'ru' ? 'Оставшееся время хода' : language === 'uk' ? "Час, що залишився на хід" : language === 'es' ? 'Tiempo restante del turno' : language === 'de' ? 'Verbleibende Zeit des Zuges' : language === 'fr' ? 'Temps restant du tour' : 'Turn time remaining'} style={{ width: 'min(340px, 80vw)', height: '5px', margin: '-8px auto 20px', overflow: 'hidden', borderRadius: '999px', background: 'rgba(255,255,255,0.1)' }}>
                    <div style={{ height: '100%', background: turnTimeLeft <= 5 ? '#ff2a5f' : '#00f0ff', boxShadow: `0 0 12px ${turnTimeLeft <= 5 ? '#ff2a5f' : '#00f0ff'}`, transformOrigin: 'left center', transform: `scaleX(${Math.max(0, Math.min(1, turnTimeLeft / TURN_DURATION_SECONDS))})`, transition: 'transform 1s linear, background-color 250ms ease', willChange: 'transform' }} />
                  </div>

                  {/* Mansion map with fog of war — visible only to whoever's turn it is.
                      Selecting a room opens a full-screen peek view so the player can
                      inspect it before ending the turn manually. */}
                  {canObserveMap && (
                    <div style={{ position: 'relative' }}>
                      {(isEliminated || isObserver) && <div style={{ margin: '0 0 12px', padding: '10px 12px', borderRadius: '10px', border: '1px solid rgba(255,42,95,0.45)', background: 'rgba(255,42,95,0.1)', color: '#ff9caf', fontSize: '11px', fontWeight: 800, letterSpacing: '1px', transition: 'all 0.3s ease' }}>{language === 'ru' ? 'НАБЛЮДЕНИЕ — СВОБОДНАЯ НАВИГАЦИЯ ПО КОМНАТАМ. АКТИВНЫЕ ИГРОКИ И ДЕЙСТВИЯ ЗАБЛОКИРОВАНЫ.' : language === 'uk' ? "СПОСТЕРЕЖЕННЯ — ВІЛЬНА НАВІГАЦІЯ КІМНАТАМИ. АКТИВНІ ГРАВЦІ ТА ДІЇ ЗАБЛОКОВАНІ." : language === 'es' ? 'ESPECTANDO — NAVEGACIÓN LIBRE POR LAS SALAS. JUGADORES ACTIVOS Y ACCIONES BLOQUEADOS.' : language === 'de' ? 'BEOBACHTER — FREIE NAVIGATION DURCH DIE RÄUME. AKTIVE SPIELER UND AKTIONEN GESPERRT.' : language === 'fr' ? 'SPECTATEUR — NAVIGATION LIBRE ENTRE LES PIÈCES. JOUEURS ACTIFS ET ACTIONS VERROUILLÉS.' : 'SPECTATING — FREE ROOM NAVIGATION. ACTIVE PLAYERS AND ACTIONS ARE LOCKED.'}</div>}
                      {canObserveMap && (
                        <MansionMap
                          floor={mansionFloor}
                          onFloorChange={setMansionFloor}
                          revealedRoom={revealedRoom}
                          roomChosen={roomChosen}
                          onSelectRoom={handleSelectRoom}
                          myCharacter={selectedChar}
                          spectatorMode={isEliminated || isObserver}
                          clearedRoomIds={clearedRoomIds}
                          myRole={myRole}
                          isMobile={isMobile}
                          language={language}
                        />
                      )}

                      {/* Joker's signature ability — planting a piece of character-specific
                          evidence in ANY mansion room of their choosing, not just the one
                          they searched this turn (see 'plant_joker_evidence'). Lives right
                          under the map, opens the room-picker modal below. */}
                      {myRole === 'Joker' && currentTurnPlayerId === socket.id && !isEliminated && !isObserver && (
                        <div style={{
                          display: 'flex',
                          justifyContent: 'center',
                          marginTop: '-6px',
                          marginBottom: '18px',
                          opacity: roomChosen ? 0 : 1,
                          transform: roomChosen ? 'translateY(6px) scale(0.98)' : 'translateY(0) scale(1)',
                          pointerEvents: roomChosen ? 'none' : 'auto',
                          transition: 'opacity 0.35s cubic-bezier(0.4,0,0.2,1), transform 0.35s cubic-bezier(0.4,0,0.2,1)'
                        }}>
                          <NeonButton
                            variant="secondary"
                            style={{
                              maxWidth: '300px',
                              width: '100%',
                              opacity: jokerEvidenceStatus?.available === false ? 0.5 : 1,
                              transition: 'opacity 0.3s ease, transform 0.2s cubic-bezier(0.4,0,0.2,1)'
                            }}
                            disabled={jokerEvidenceStatus?.available === false}
                            onClick={handleOpenJokerPlantPicker}
                          >
                            {jokerEvidenceStatus?.available === false
                              ? (language === 'ru'
                                  ? `ПОДБРОСИТЬ УЛИКУ (ОСТАЛОСЬ ${jokerEvidenceStatus.turnsRemaining} ХОД${jokerEvidenceStatus.turnsRemaining === 1 ? '' : (jokerEvidenceStatus.turnsRemaining >= 2 && jokerEvidenceStatus.turnsRemaining <= 4 ? 'А' : 'ОВ')})`
                                  : language === 'uk' ? `ПІДКИНУТИ ДОКАЗ (ЗАЛИШИЛОСЯ ${jokerEvidenceStatus.turnsRemaining} ${(jokerEvidenceStatus.turnsRemaining === 1 ? 'ХІД' : (jokerEvidenceStatus.turnsRemaining >= 2 && jokerEvidenceStatus.turnsRemaining <= 4 ? 'ХОДИ' : 'ХОДІВ'))})` : language === 'es' ? `PLANTAR PRUEBA (QUEDAN ${jokerEvidenceStatus.turnsRemaining} TURNO${jokerEvidenceStatus.turnsRemaining === 1 ? '' : 'S'})` : language === 'de' ? `BEWEIS PLATZIEREN (NOCH ${jokerEvidenceStatus.turnsRemaining} ZUG${jokerEvidenceStatus.turnsRemaining === 1 ? '' : 'E'})` : language === 'fr' ? `PLACER UNE PREUVE (${jokerEvidenceStatus.turnsRemaining} TOUR${jokerEvidenceStatus.turnsRemaining === 1 ? '' : 'S'} RESTANT(S))` : `PLANT EVIDENCE (${jokerEvidenceStatus.turnsRemaining} TURN${jokerEvidenceStatus.turnsRemaining === 1 ? '' : 'S'} LEFT)`)
                              : <><Icon name="search" size={14} style={{ marginRight: 7 }} />{language === 'ru' ? 'ПОДБРОСИТЬ УЛИКУ' : language === 'uk' ? "ПІДКИНУТИ ДОКАЗ" : language === 'es' ? 'PLANTAR PRUEBA' : language === 'de' ? 'BEWEIS PLATZIEREN' : language === 'fr' ? 'PLACER UNE PREUVE' : 'PLANT EVIDENCE'}</>}
                          </NeonButton>
                        </div>
                      )}

                      {jokerPlantPickerOpen && (
                        <JokerPlantRoomPicker
                          floor={jokerPlantFloor}
                          onFloorChange={setJokerPlantFloor}
                          onChooseRoom={handleChooseJokerPlantRoom}
                          submittingRoomId={jokerPlantSubmittingRoomId}
                          onClose={() => { if (!jokerPlantSubmittingRoomId) setJokerPlantPickerOpen(false); }}
                          language={language}
                        />
                      )}

                      {/* Killer's Accomplice — "SET A TRAP": same spot/pattern as the
                          Joker's PLANT EVIDENCE button above, pins a trap to any mansion
                          room of the Accomplice's choosing (see 'set_trap'). Currently
                          inert — nothing reads the trap yet to do anything with it. */}
                      {myRole === 'Accomplice' && currentTurnPlayerId === socket.id && !isEliminated && !isObserver && (
                        <div style={{
                          display: 'flex',
                          justifyContent: 'center',
                          marginTop: '-6px',
                          marginBottom: '18px',
                          opacity: roomChosen ? 0 : 1,
                          transform: roomChosen ? 'translateY(6px) scale(0.98)' : 'translateY(0) scale(1)',
                          pointerEvents: roomChosen ? 'none' : 'auto',
                          transition: 'opacity 0.35s cubic-bezier(0.4,0,0.2,1), transform 0.35s cubic-bezier(0.4,0,0.2,1)'
                        }}>
                          <NeonButton
                            variant="secondary"
                            style={{
                              maxWidth: '300px',
                              width: '100%',
                              opacity: accompliceTrapStatus?.available === false ? 0.5 : 1,
                              transition: 'opacity 0.3s ease, transform 0.2s cubic-bezier(0.4,0,0.2,1)'
                            }}
                            disabled={accompliceTrapStatus?.available === false}
                            onClick={handleOpenAccompliceTrapPicker}
                          >
                            {accompliceTrapStatus?.available === false
                              ? (language === 'ru'
                                  ? `УСТАНОВИТЬ ЛОВУШКУ (ОСТАЛОСЬ ${accompliceTrapStatus.roundsRemaining} РАУНД${accompliceTrapStatus.roundsRemaining === 1 ? '' : (accompliceTrapStatus.roundsRemaining >= 2 && accompliceTrapStatus.roundsRemaining <= 4 ? 'А' : 'ОВ')})`
                                  : language === 'uk' ? `ВСТАНОВИТИ ПАСТКУ (ЗАЛИШИЛОСЯ ${accompliceTrapStatus.roundsRemaining} ${(accompliceTrapStatus.roundsRemaining === 1 ? 'РАУНД' : (accompliceTrapStatus.roundsRemaining >= 2 && accompliceTrapStatus.roundsRemaining <= 4 ? 'РАУНДИ' : 'РАУНДІВ'))})` : language === 'es' ? `INSTALAR TRAMPA (QUEDAN ${accompliceTrapStatus.roundsRemaining} RONDA${accompliceTrapStatus.roundsRemaining === 1 ? '' : 'S'})` : language === 'de' ? `FALLE STELLEN (NOCH ${accompliceTrapStatus.roundsRemaining} RUNDE${accompliceTrapStatus.roundsRemaining === 1 ? '' : 'N'})` : language === 'fr' ? `POSER UN PIÈGE (${accompliceTrapStatus.roundsRemaining} ROUND${accompliceTrapStatus.roundsRemaining === 1 ? '' : 'S'} RESTANT(S))` : `SET A TRAP (${accompliceTrapStatus.roundsRemaining} ROUND${accompliceTrapStatus.roundsRemaining === 1 ? '' : 'S'} LEFT)`)
                              : <><Icon name="search" size={14} style={{ marginRight: 7 }} />{language === 'ru' ? 'УСТАНОВИТЬ ЛОВУШКУ' : language === 'uk' ? "ВСТАНОВИТИ ПАСТКУ" : language === 'es' ? 'INSTALAR TRAMPA' : language === 'de' ? 'FALLE STELLEN' : language === 'fr' ? 'POSER UN PIÈGE' : 'SET A TRAP'}</>}
                          </NeonButton>
                        </div>
                      )}

                      {accompliceTrapPickerOpen && (
                        <AccompliceTrapRoomPicker
                          floor={accompliceTrapFloor}
                          onFloorChange={setAccompliceTrapFloor}
                          onChooseRoom={handleChooseAccompliceTrapRoom}
                          submittingRoomId={accompliceTrapSubmittingRoomId}
                          onClose={() => { if (!accompliceTrapSubmittingRoomId) setAccompliceTrapPickerOpen(false); }}
                          language={language}
                        />
                      )}

                      {changeEvidencePickerOpen && (
                        <AccompliceChangeEvidenceModal
                          evidenceText={translateEvidenceName((revealedRoom?.evidence || []).find(item => item.id === changeEvidenceTargetEvidenceId)?.text, language)}
                          players={activeRoom?.players || []}
                          selfId={socket.id}
                          submittingTargetId={changeEvidenceSubmittingTargetId}
                          onChooseTarget={handleSubmitChangeEvidence}
                          onClose={() => {
                            if (changeEvidenceSubmittingTargetId) return;
                            setChangeEvidencePickerOpen(false);
                            setChangeEvidenceTargetEvidenceId(null);
                          }}
                          language={language}
                        />
                      )}

                      {/* Killer only: mandatory post-kill decision — deliberately has no
                          onClose/backdrop-dismiss, unlike the Joker's picker above. The
                          Killer must pick one of the two options (see KillDecisionModal /
                          handleResolveKill) before their turn can otherwise continue. */}
                      {pendingKillDecision && (
                        <KillDecisionModal
                          targetNickname={pendingKillDecision.targetNickname}
                          resolving={resolvingKill}
                          onChoose={handleResolveKill}
                          language={language}
                        />
                      )}

                      {roomChosen && revealedRoom && (() => {
                        const roomInterior = ROOM_INTERIORS[revealedRoom.roomId];
                        const roomAccent = roomInterior?.accent || '#00ff87';
                        return (
                        <div style={{
                          position: 'fixed',
                          inset: 0,
                          background: 'rgba(2, 4, 10, 0.9)',
                          backdropFilter: 'blur(16px)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: '24px',
                          zIndex: 30,
                          animation: 'roomPeekIn 420ms cubic-bezier(0.16, 1, 0.3, 1)'
                        }}>
                          <div style={{
                            width: 'min(760px, 100%)',
                            height: 'min(700px, 90vh)',
                            background: 'linear-gradient(145deg, rgba(13, 14, 24, 0.95) 0%, rgba(7, 8, 15, 0.98) 100%)',
                            border: `1px solid ${roomAccent}55`,
                            borderRadius: '22px',
                            boxShadow: `0 28px 90px rgba(0, 0, 0, 0.45), 0 0 60px -20px ${roomAccent}66`,
                            padding: '22px',
                            boxSizing: 'border-box',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '16px',
                            animation: 'roomPeekIn 460ms cubic-bezier(0.16, 1, 0.3, 1)'
                          }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                <div style={{
                                  width: '40px',
                                  height: '40px',
                                  borderRadius: '10px',
                                  border: `1px solid ${roomAccent}66`,
                                  background: `${roomAccent}1a`,
                                  boxShadow: `0 0 16px ${roomAccent}33`,
                                  flexShrink: 0,
                                  padding: '6px',
                                  boxSizing: 'border-box'
                                }}>
                                  <RoomArtIcon roomId={revealedRoom.roomId} color={roomAccent} />
                                </div>
                                <div>
                                  <p style={{ margin: '0 0 4px 0', fontSize: '11px', letterSpacing: '2px', color: '#8a99ad' }}>
                                    {language === 'ru' ? 'ПРОСМОТР' : language === 'uk' ? "ПЕРЕГЛЯД" : language === 'es' ? 'VISTA' : language === 'de' ? 'EINBLICK' : language === 'fr' ? "COUP D'ŒIL DANS" : 'PEEKING INTO'}
                                  </p>
                                  <h3 style={{ margin: 0, fontSize: '26px', color: roomAccent, letterSpacing: '1px', textShadow: `0 0 18px ${roomAccent}55` }}>{translateRoomName(revealedRoom.roomName, language).toUpperCase()}</h3>
                                </div>
                              </div>
                              <div style={{ fontSize: '11px', letterSpacing: '1px', color: '#6272a4', textAlign: 'right' }}>
                                {(isEliminated || isObserver)
                                  ? (language === 'ru' ? 'РЕЖИМ НАБЛЮДЕНИЯ — ПРИСУТСТВУЮЩИЕ' : language === 'uk' ? "РЕЖИМ СПОСТЕРЕЖЕННЯ — ПРИСУТНІ" : language === 'es' ? 'MODO ESPECTADOR — PRESENTES' : language === 'de' ? 'BEOBACHTERMODUS — ANWESEND' : language === 'fr' ? 'VUE SPECTATEUR — OCCUPANTS EN DIRECT' : 'SPECTATOR VIEW — LIVE OCCUPANTS')
                                  : (language === 'ru' ? `ТАЙМЕР ХОДА: ${turnTimeLeft}с` : language === 'uk' ? `ТАЙМЕР ХОДУ: ${turnTimeLeft}с` : language === 'es' ? `TEMPORIZADOR DE TURNO: ${turnTimeLeft}s` : language === 'de' ? `ZUG-TIMER: ${turnTimeLeft}s` : language === 'fr' ? `MINUTEUR DU TOUR : ${turnTimeLeft}s` : `TURN TIMER: ${turnTimeLeft}s`)}
                              </div>
                            </div>

                            <div style={{
                              flex: 1,
                              borderRadius: '18px',
                              border: `1px solid ${roomAccent}29`,
                              background: `radial-gradient(circle at top left, ${roomAccent}1a, transparent 35%), linear-gradient(135deg, rgba(255,255,255,0.03) 0%, rgba(0,0,0,0.3) 100%)`,
                              position: 'relative',
                              overflow: 'hidden',
                              minHeight: '320px',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '12px',
                              padding: '16px'
                            }}>
                              <div style={{
                                flex: 1,
                                borderRadius: '16px',
                                border: '1px solid rgba(255,255,255,0.12)',
                                background: 'linear-gradient(160deg, rgba(255,255,255,0.05) 0%, rgba(0,0,0,0.3) 100%)',
                                boxShadow: 'inset 0 0 80px rgba(0,0,0,0.35)',
                                position: 'relative',
                                overflow: 'hidden'
                              }}>
                                <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(120deg, transparent 0%, rgba(255,255,255,0.04) 45%, transparent 100%)', zIndex: 1, pointerEvents: 'none' }} />
                                <div style={{ position: 'absolute', inset: 0 }}>
                                  <RoomVisualScene
                                    roomId={revealedRoom.roomId}
                                    accent={roomAccent}
                                    occupants={revealedRoom.occupants || []}
                                    bodies={revealedRoom.bodies || []}
                                  />
                                </div>
                                {/* HUD-style corner brackets in the room's accent color —
                                    frames the scene like a targeting/surveillance readout
                                    rather than a plain rounded rectangle. */}
                                {[
                                  { top: '10px', left: '10px', borderWidth: '2px 0 0 2px' },
                                  { top: '10px', right: '10px', borderWidth: '2px 2px 0 0' },
                                  { bottom: '10px', left: '10px', borderWidth: '0 0 2px 2px' },
                                  { bottom: '10px', right: '10px', borderWidth: '0 2px 2px 0' }
                                ].map((corner, i) => (
                                  <div key={i} style={{
                                    position: 'absolute',
                                    width: '18px',
                                    height: '18px',
                                    borderStyle: 'solid',
                                    borderColor: `${roomAccent}99`,
                                    pointerEvents: 'none',
                                    ...corner
                                  }} />
                                ))}
                              </div>

                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
                                {revealedRoom.occupants.length === 0 ? (
                                  <span style={{ fontSize: '12px', color: '#8a99ad', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '999px', padding: '6px 10px' }}>
                                    {language === 'ru' ? 'ЗДЕСЬ БОЛЬШЕ НИКОГО НЕТ' : language === 'uk' ? "ТУТ БІЛЬШЕ НІКОГО НЕМАЄ" : language === 'es' ? 'AQUÍ NO HAY NADIE MÁS' : language === 'de' ? 'HIER IST SONST NIEMAND' : language === 'fr' ? 'AUCUN AUTRE AGENT ICI' : 'NO OTHER AGENTS HERE'}
                                  </span>
                                ) : revealedRoom.occupants.map((occupant, idx) => {
                                  const occupantAvatarUrl = getCharacterUrl(occupant.character);
                                  // Killer only, on their own turn, not spectating, and never
                                  // while a previous kill's body decision is still pending —
                                  // clicking this occupant's avatar/nickname triggers the kill
                                  // (see handleKillPlayer). Every other role just sees the same
                                  // plain presence chip as before.
                                  const canKillThis = myRole === 'Killer'
                                    && currentTurnPlayerId === socket.id
                                    && !isEliminated && !isObserver
                                    && !pendingKillDecision
                                    && occupant.id
                                    && occupant.id !== socket.id;
                                  return (
                                    <div
                                      key={occupant.id || idx}
                                      onClick={canKillThis ? () => handleKillPlayer(occupant.id) : undefined}
                                      onMouseEnter={canKillThis ? () => playHoverSound(0.2) : undefined}
                                      onTouchStart={canKillThis ? () => playHoverSound(0.2) : undefined}
                                      title={canKillThis ? (language === 'ru' ? `Устранить ${occupant.nickname}` : language === 'uk' ? `Усунути ${occupant.nickname}` : language === 'es' ? `Eliminar a ${occupant.nickname}` : language === 'de' ? `${occupant.nickname} ausschalten` : language === 'fr' ? `Éliminer ${occupant.nickname}` : `Eliminate ${occupant.nickname}`) : undefined}
                                      style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '8px',
                                        padding: '6px 10px',
                                        borderRadius: '999px',
                                        border: canKillThis ? '1px solid rgba(255,42,95,0.55)' : '1px solid rgba(0,255,135,0.18)',
                                        background: canKillThis ? 'rgba(255,42,95,0.12)' : 'rgba(0,255,135,0.08)',
                                        color: canKillThis ? '#ff9caf' : '#c9d3e0',
                                        cursor: canKillThis ? 'pointer' : 'default',
                                        boxShadow: canKillThis ? '0 0 14px rgba(255,42,95,0.25)' : 'none',
                                        opacity: 0,
                                        transition: 'all 0.2s ease',
                                        animation: `trialCardEnter 380ms cubic-bezier(0.16, 1, 0.3, 1) ${idx * 80}ms forwards`
                                      }}
                                    >
                                      {occupantAvatarUrl ? (
                                        <img src={occupantAvatarUrl} alt={occupant.nickname} style={{ width: '24px', height: '24px', borderRadius: '50%', objectFit: 'cover', border: canKillThis ? '1px solid rgba(255,42,95,0.5)' : '1px solid rgba(255,255,255,0.16)' }} />
                                      ) : (
                                        <div style={{ width: '24px', height: '24px', borderRadius: '50%', background: 'rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', color: '#fff' }}>
                                          {occupant.nickname?.[0]?.toUpperCase() || '?'}
                                        </div>
                                      )}
                                      <span style={{ fontSize: '12px' }}>{occupant.nickname}</span>
                                      {canKillThis && <Icon name="knife" size={13} color="#ff9caf" />}
                                    </div>
                                  );
                                })}
                              </div>

                              {/* Exposed bodies (isHidden: false) in this room — detectable just by
                                  walking in, no explicit "SEARCH FOR BODY" needed (see 'resolve_kill'
                                  and the 'bodies' field on 'room_entered'/'spectator_room_update'). A
                                  hidden body never shows up here, only via search_body's own toast. */}
                              {(revealedRoom.bodies || []).length > 0 && (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
                                  {revealedRoom.bodies.map((body, idx) => (
                                    <div key={idx} style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '8px',
                                      padding: '6px 10px',
                                      borderRadius: '999px',
                                      border: '1px solid rgba(255,93,115,0.35)',
                                      background: 'rgba(255,93,115,0.08)',
                                      color: '#ff9caf',
                                      opacity: 0,
                                      animation: `trialCardEnter 380ms cubic-bezier(0.16, 1, 0.3, 1) ${idx * 80}ms forwards`
                                    }}>
                                      <span style={{ fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}><Icon name="skull" size={12} />{body.nickname}'s body</span>
                                    </div>
                                  ))}
                                </div>
                              )}

                              {/* Evidence physically planted in this room by the Joker (see
                                  'plant_joker_evidence'). Only surfaces once someone actually runs
                                  'investigate_room' — same for every role, including the
                                  Accomplice, who has no passive free reveal anymore and has to
                                  investigate like everyone else before they can use "CHANGE
                                  EVIDENCE" on anything found. The server never says who left it,
                                  only what was found — and Code Fragments (the digital escape code
                                  digits) never travel through this field at all, so they still
                                  require a normal 'investigate_room' search. */}
                              {(revealedRoom.evidence || []).length > 0 && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                  {myRole === 'Accomplice' && (
                                    <p style={{ margin: 0, fontSize: '10px', letterSpacing: '2px', color: '#ff9100' }}>
                                      {language === 'ru' ? 'СООБЩНИК — НАЖМИТЕ НА УЛИКУ, ЧТОБЫ ПОДСТАВИТЬ' : language === 'uk' ? "СПІЛЬНИК — НАТИСНІТЬ НА ДОКАЗ, ЩОБ ПІДСТАВИТИ" : language === 'es' ? 'CÓMPLICE — TOCA UNA PRUEBA PARA INCRIMINAR' : language === 'de' ? 'KOMPLIZE — TIPPE AUF EINEN BEWEIS, UM ZU BELASTEN' : language === 'fr' ? 'COMPLICE — TOUCHEZ UNE PREUVE POUR INCRIMINER' : 'ACCOMPLICE — TAP EVIDENCE TO REFRAME'}
                                    </p>
                                  )}
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
                                  {revealedRoom.evidence.map((item, idx) => {
                                    // Accomplice-only: clicking a specific evidence chip opens the
                                    // "CHANGE EVIDENCE" modal pre-targeted at THIS item — the only
                                    // way to trigger this ability now that there's no standalone
                                    // button (see handleOpenChangeEvidence). This is a separate
                                    // ability from "INVESTIGATE ROOM" — evidence only ever shows up
                                    // here AFTER that room-action slot has already been spent, so
                                    // it's gated only on its own cooldown, not on roomActionTaken.
                                    const canChangeThis = myRole === 'Accomplice'
                                      && accompliceEvidenceStatus?.available !== false;
                                    return (
                                    <div
                                      key={item.id || idx}
                                      onClick={canChangeThis ? () => handleOpenChangeEvidence(item.id) : undefined}
                                      onMouseEnter={canChangeThis ? () => playHoverSound(0.12) : undefined}
                                      onTouchStart={canChangeThis ? () => playHoverSound(0.12) : undefined}
                                      title={canChangeThis ? (language === 'ru' ? 'Изменить эту улику' : language === 'uk' ? "Змінити цей доказ" : language === 'es' ? 'Cambiar esta prueba' : language === 'de' ? 'Diesen Beweis ändern' : language === 'fr' ? 'Modifier cette preuve' : 'Change this evidence') : undefined}
                                      style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '8px',
                                      padding: '6px 10px',
                                      borderRadius: '999px',
                                      border: '1px solid rgba(224,64,251,0.35)',
                                      background: 'rgba(224,64,251,0.1)',
                                      color: '#f0c6ff',
                                      cursor: canChangeThis ? 'pointer' : 'default',
                                      opacity: 0,
                                      animation: `trialCardEnter 380ms cubic-bezier(0.16, 1, 0.3, 1) ${idx * 80}ms forwards`
                                    }}>
                                      <span style={{ fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}><Icon name="search" size={12} />{translateEvidenceName(item.text, language)}</span>
                                      {canChangeThis && <span style={{ fontSize: '10px', letterSpacing: '1px', color: '#ffb974' }}>{language === 'ru' ? 'ИЗМЕНИТЬ' : language === 'uk' ? "ЗМІНИТИ" : language === 'es' ? 'CAMBIAR' : language === 'de' ? 'ÄNDERN' : language === 'fr' ? 'MODIFIER' : 'CHANGE'}</span>}
                                    </div>
                                    );
                                  })}
                                  </div>
                                </div>
                              )}
                            </div>

                            <div
                              className={isMobile ? 'action-btn-scroll' : undefined}
                              style={isMobile ? {
                                display: 'flex',
                                gap: '10px',
                                overflowX: 'auto',
                                overflowY: 'hidden',
                                flexWrap: 'nowrap',
                                justifyContent: (isEliminated || isObserver) ? 'center' : 'flex-start',
                                padding: '2px 4px 10px 4px',
                                margin: '0 -4px',
                                scrollSnapType: 'x proximity'
                              } : { display: 'flex', justifyContent: 'center', gap: '12px', flexWrap: 'wrap' }}
                            >
                              {(isEliminated || isObserver) ? (
                                <NeonButton variant="secondary" style={{ maxWidth: '260px', width: '100%', flexShrink: 0, marginBottom: 0 }} onClick={() => setRoomChosen(false)}>{language === 'ru' ? 'ВЕРНУТЬСЯ К КАРТЕ ОСОБНЯКА' : language === 'uk' ? "ПОВЕРНУТИСЯ ДО КАРТИ ОСОБНЯКА" : language === 'es' ? 'VOLVER AL MAPA DE LA MANSIÓN' : language === 'de' ? 'ZURÜCK ZUR ANWESENKARTE' : language === 'fr' ? 'RETOUR À LA CARTE DU MANOIR' : 'RETURN TO MANSION MAP'}</NeonButton>
                              ) : (
                                <>
                                  {/* Two mutually-exclusive room actions: picking either one spends
                                      this turn's single room-interaction phase and greys out both
                                      buttons (see roomActionTaken) until a fresh room is entered
                                      (new 'select_room' or a vent hop) or a new turn starts. */}
                                  <NeonButton
                                    variant="primary"
                                    style={{ maxWidth: '260px', width: isMobile ? '220px' : '100%', flexShrink: 0, marginBottom: isMobile ? 0 : 14, scrollSnapAlign: 'start', opacity: roomActionTaken ? 0.5 : 1, gap: '8px' }}
                                    disabled={roomActionTaken}
                                    onClick={handleSearchBody}
                                  >
                                    <Icon name="search" size={14} /> {language === 'ru' ? 'ИСКАТЬ ТЕЛО' : language === 'uk' ? "ШУКАТИ ТІЛО" : language === 'es' ? 'BUSCAR CUERPO' : language === 'de' ? 'NACH LEICHE SUCHEN' : language === 'fr' ? 'CHERCHER UN CORPS' : 'SEARCH FOR BODY'}
                                  </NeonButton>
                                  <NeonButton
                                    variant="primary"
                                    style={{ maxWidth: '260px', width: isMobile ? '220px' : '100%', flexShrink: 0, marginBottom: isMobile ? 0 : 14, scrollSnapAlign: 'start', opacity: roomActionTaken ? 0.5 : 1 }}
                                    disabled={roomActionTaken}
                                    onClick={handleInvestigateRoom}
                                  >
                                    {language === 'ru' ? 'ОБЫСКАТЬ КОМНАТУ' : language === 'uk' ? "ОБШУКАТИ КІМНАТУ" : language === 'es' ? 'REGISTRAR SALA' : language === 'de' ? 'RAUM DURCHSUCHEN' : language === 'fr' ? 'ENQUÊTER SUR LA PIÈCE' : 'INVESTIGATE ROOM'}
                                  </NeonButton>
                                  {/* NOTE: Neurotoxin-7 no longer has a standalone pickup button —
                                      the server folds the pickup (or the reason it failed) directly
                                      into INVESTIGATE ROOM above and reports it via the `neurotoxin`
                                      field on 'investigate_result' (see onInvestigateResult), which
                                      pops the dedicated NEUROTOXIN-7 popup and sets the top-left
                                      carrier badge. This dead button used to be gated on
                                      revealedRoom.neurotoxinPresent, a flag the server never actually
                                      sent — so it could never render, making the syringe look like it
                                      had already vanished from the room before anyone searched it. */}
                                  {/* Innocent-only: "CHECK ROOM" (Mark Room) — a SEPARATE ability
                                      from the two above, not gated on roomActionTaken so it can be
                                      used after SEARCH FOR BODY too. It IS, however, gated on
                                      INVESTIGATE ROOM having already been used on this room first
                                      (investigateUsedThisTurn) — see handleCheckRoom. Also disables
                                      itself once the room is already known-clear (no point wasting
                                      the cooldown), while its own cooldown is off, or while a
                                      request is in flight. */}
                                  {myRole === 'Innocent' && (() => {
                                    const alreadyCleared = Boolean(clearedRoomIds[revealedRoom.roomId]);
                                    const onCooldown = markRoomStatus?.available === false;
                                    const needsInvestigateFirst = !investigateUsedThisTurn;
                                    const checkDisabled = alreadyCleared || onCooldown || checkRoomSubmitting || needsInvestigateFirst;
                                    return (
                                      <NeonButton
                                        variant="success"
                                        style={{ maxWidth: '260px', width: isMobile ? '220px' : '100%', flexShrink: 0, marginBottom: isMobile ? 0 : 14, scrollSnapAlign: 'start', opacity: checkDisabled ? 0.5 : 1, gap: '8px' }}
                                        disabled={checkDisabled}
                                        onClick={handleCheckRoom}
                                        title={needsInvestigateFirst && !alreadyCleared ? (language === 'ru' ? 'Сначала обыщите эту комнату' : language === 'uk' ? "Спочатку обшукайте цю кімнату" : language === 'es' ? 'Registra esta sala primero' : language === 'de' ? 'Durchsuche zuerst diesen Raum' : language === 'fr' ? "Enquêtez d'abord sur cette pièce" : 'Investigate this room first') : undefined}
                                      >
                                        {alreadyCleared
                                          ? <><Icon name="check" size={14} /> {language === 'ru' ? 'УЖЕ ПРОВЕРЕНО' : language === 'uk' ? "ВЖЕ ПЕРЕВІРЕНО" : language === 'es' ? 'YA REVISADO' : language === 'de' ? 'BEREITS GEPRÜFT' : language === 'fr' ? 'DÉJÀ DISCULPÉ' : 'ALREADY CLEAR'}</>
                                          : onCooldown
                                            ? (language === 'ru'
                                                ? `ПРОВЕРИТЬ КОМНАТУ (ОСТАЛОСЬ ${markRoomStatus.turnsRemaining} РАУНД${markRoomStatus.turnsRemaining === 1 ? '' : (markRoomStatus.turnsRemaining >= 2 && markRoomStatus.turnsRemaining <= 4 ? 'А' : 'ОВ')})`
                                                : language === 'uk' ? `ПЕРЕВІРИТИ КІМНАТУ (ЗАЛИШИЛОСЯ ${markRoomStatus.turnsRemaining} ${(markRoomStatus.turnsRemaining === 1 ? 'РАУНД' : (markRoomStatus.turnsRemaining >= 2 && markRoomStatus.turnsRemaining <= 4 ? 'РАУНДИ' : 'РАУНДІВ'))})` : language === 'es' ? `REVISAR SALA (QUEDAN ${markRoomStatus.turnsRemaining} RONDA${markRoomStatus.turnsRemaining === 1 ? '' : 'S'})` : language === 'de' ? `RAUM PRÜFEN (NOCH ${markRoomStatus.turnsRemaining} RUNDE${markRoomStatus.turnsRemaining === 1 ? '' : 'N'})` : language === 'fr' ? `VÉRIFIER LA PIÈCE (${markRoomStatus.turnsRemaining} ROUND${markRoomStatus.turnsRemaining === 1 ? '' : 'S'} RESTANT(S))` : `CHECK ROOM (${markRoomStatus.turnsRemaining} ROUND${markRoomStatus.turnsRemaining === 1 ? '' : 'S'} LEFT)`)
                                            : needsInvestigateFirst
                                              ? (language === 'ru' ? 'СНАЧАЛА ОБЫЩИТЕ' : language === 'uk' ? "СПОЧАТКУ ОБШУКАЙТЕ" : language === 'es' ? 'REGISTRA PRIMERO' : language === 'de' ? 'ZUERST DURCHSUCHEN' : language === 'fr' ? "D'ABORD ENQUÊTER" : 'INVESTIGATE FIRST')
                                              : <><Icon name="check" size={14} /> {language === 'ru' ? 'ПРОВЕРИТЬ КОМНАТУ' : language === 'uk' ? "ПЕРЕВІРИТИ КІМНАТУ" : language === 'es' ? 'REVISAR SALA' : language === 'de' ? 'RAUM PRÜFEN' : language === 'fr' ? 'VÉRIFIER LA PIÈCE' : 'CHECK ROOM'}</>}
                                      </NeonButton>
                                    );
                                  })()}
                                  {/* Killer-only shortcut: only shows up when the room they're
                                      currently standing in actually has a vent (see VENTS), and
                                      disables itself the instant it's used — a killer gets exactly
                                      one hop, no climbing back through the same vent this turn. */}
                                  {myRole === 'Killer' && VENTS[revealedRoom.roomId] && (
                                    <NeonButton
                                      variant="secondary"
                                      style={{ maxWidth: '260px', width: isMobile ? '220px' : '100%', flexShrink: 0, marginBottom: isMobile ? 0 : 14, scrollSnapAlign: 'start', opacity: ventUsedThisTurn ? 0.5 : 1, gap: '8px' }}
                                      disabled={ventUsedThisTurn}
                                      onClick={handleUseVent}
                                    >
                                      {ventUsedThisTurn ? (language === 'ru' ? 'ВЕНТИЛЯЦИЯ ИСПОЛЬЗОВАНА' : language === 'uk' ? "ВЕНТИЛЯЦІЮ ВИКОРИСТАНО" : language === 'es' ? 'CONDUCTO USADO' : language === 'de' ? 'SCHACHT BENUTZT' : language === 'fr' ? 'CONDUIT UTILISÉ' : 'VENT USED') : <><Icon name="vent" size={14} /> {language === 'ru' ? 'ИСПОЛЬЗОВАТЬ ВЕНТИЛЯЦИЮ' : language === 'uk' ? "ВИКОРИСТАТИ ВЕНТИЛЯЦІЮ" : language === 'es' ? 'USAR CONDUCTO' : language === 'de' ? 'SCHACHT BENUTZEN' : language === 'fr' ? 'UTILISER LE CONDUIT' : 'USE VENT'}</>}
                                    </NeonButton>
                                  )}
                                  <NeonButton variant="success" style={{ maxWidth: '260px', width: isMobile ? '220px' : '100%', flexShrink: 0, marginBottom: isMobile ? 0 : 14, scrollSnapAlign: 'start' }} onClick={handleEndTurn}>{language === 'ru' ? 'ЗАКОНЧИТЬ ХОД' : language === 'uk' ? "ЗАВЕРШИТИ ХІД" : language === 'es' ? 'TERMINAR TURNO' : language === 'de' ? 'ZUG BEENDEN' : language === 'fr' ? 'TERMINER LE TOUR' : 'END TURN'}</NeonButton>
                                </>
                              )}
                            </div>
                            {isMobile && !(isEliminated || isObserver) && (
                              <p style={{ margin: '-4px 0 0 0', fontSize: '10px', color: '#5a6478', letterSpacing: '1px', textAlign: 'center' }}>
                                {language === 'ru' ? '← ПРОЛИСТНИТЕ, ЧТОБЫ УВИДЕТЬ ВСЕ ДЕЙСТВИЯ →' : language === 'uk' ? "← ПРОГОРНІТЬ, ЩОБ ПОБАЧИТИ ВСІ ДІЇ →" : language === 'es' ? '← DESLIZA PARA VER TODAS LAS ACCIONES →' : language === 'de' ? '← WISCHEN, UM ALLE AKTIONEN ZU SEHEN →' : language === 'fr' ? '← GLISSEZ POUR VOIR TOUTES LES ACTIONS →' : '← SWIPE TO SEE ALL ACTIONS →'}
                              </p>
                            )}
                          </div>
                        </div>
                      )})()}
                    </div>
                  )}
                </>
              )}

              {displayPhase === 'trial' && (
                <div style={{
                  position: 'fixed',
                  inset: 0,
                  background: 'rgba(2, 4, 10, 0.92)',
                  backdropFilter: 'blur(14px)',
                  display: 'flex',
                  // NOTE: alignItems must stay 'flex-start', not 'center'. With
                  // 'center', a modal taller than the viewport gets clipped
                  // equally off BOTH the top and bottom, and overflowY: 'auto'
                  // can't scroll past scrollTop 0 to reach the clipped top —
                  // so the TIME LEFT timer (the very first thing in the card)
                  // silently became unreachable whenever the trial card's
                  // content (role actions + player roster) ran taller than
                  // the screen. 'flex-start' always renders the top of the
                  // card in view and lets the rest scroll down to fully see it.
                  alignItems: 'flex-start',
                  justifyContent: 'center',
                  padding: isMobile ? '10px' : '24px',
                  zIndex: 25,
                  overflowY: 'auto'
                  , animation: 'roomPeekIn 500ms cubic-bezier(0.16, 1, 0.3, 1)'
                }}>
                  <div style={{
                    width: 'min(1080px, 100%)',
                    background: 'linear-gradient(145deg, rgba(12, 14, 24, 0.98) 0%, rgba(5, 7, 12, 0.98) 100%)',
                    border: '1px solid rgba(0, 240, 255, 0.18)',
                    borderRadius: isMobile ? '16px' : '24px',
                    boxShadow: '0 30px 100px rgba(0, 240, 255, 0.12)',
                    padding: isMobile ? '14px' : '24px',
                    boxSizing: 'border-box',
                    display: 'grid',
                    gap: isMobile ? '14px' : '18px',
                    // On mobile the two-column grid (which needed 300px + 360px
                    // minimum, ~660px total) never fit a phone screen and forced
                    // everything — the dossier especially — into a squeezed,
                    // unreadable sliver. Below the breakpoint, stack the vote
                    // list and the dossier as a single column instead.
                    gridTemplateColumns: isMobile ? '1fr' : 'minmax(300px, 0.9fr) minmax(360px, 1.1fr)'
                  }}>
                    <div>
                      <div style={{ display: 'flex', flexWrap: isMobile ? 'wrap' : 'nowrap', justifyContent: 'space-between', alignItems: isMobile ? 'flex-start' : 'center', gap: isMobile ? '10px' : 0, marginBottom: '14px' }}>
                        <div>
                          <p style={{ margin: '0 0 4px 0', fontSize: '11px', letterSpacing: '2px', color: '#8a99ad' }}>{language === 'ru' ? 'ЗАСЕДАНИЕ СОВЕТА' : language === 'uk' ? "ЗАСІДАННЯ РАДИ" : language === 'es' ? 'SESIÓN DEL CONSEJO' : language === 'de' ? 'RATSSITZUNG' : language === 'fr' ? 'SESSION DU CONSEIL' : 'COUNCIL SESSION'}</p>
                          <h3 style={{ margin: 0, fontSize: isMobile ? '19px' : '24px', color: '#00f0ff', letterSpacing: '1px' }}>{language === 'ru' ? 'ГОЛОСОВАНИЕ О КАЗНИ' : language === 'uk' ? "ГОЛОСУВАННЯ ПРО СТРАТУ" : language === 'es' ? 'VOTACIÓN DE EJECUCIÓN' : language === 'de' ? 'HINRICHTUNGSABSTIMMUNG' : language === 'fr' ? "VOTE D'EXÉCUTION" : 'EXECUTION VOTE'}</h3>
                        </div>
                        <div style={{ textAlign: isMobile ? 'left' : 'right', width: isMobile ? '100%' : 'auto' }}>
                          <div style={{ fontSize: '11px', letterSpacing: '1px', color: '#8a99ad' }}>{language === 'ru' ? 'ОСТАЛОСЬ ВРЕМЕНИ' : language === 'uk' ? "ЗАЛИШИЛОСЯ ЧАСУ" : language === 'es' ? 'TIEMPO RESTANTE' : language === 'de' ? 'VERBLEIBENDE ZEIT' : language === 'fr' ? 'TEMPS RESTANT' : 'TIME LEFT'}</div>
                          <div style={{ fontSize: '32px', fontWeight: 900, color: trialTimeLeft && trialTimeLeft <= 10 ? '#ff2a5f' : '#00f0ff' }}>
                            {trialTimeLeft ?? '--'}s
                          </div>
                          <div aria-label={language === 'ru' ? 'Оставшееся время суда' : language === 'uk' ? "Час, що залишився до кінця суду" : language === 'es' ? 'Tiempo restante del juicio' : language === 'de' ? 'Verbleibende Zeit des Prozesses' : language === 'fr' ? 'Temps restant du procès' : 'Trial time remaining'} style={{ width: isMobile ? '100%' : '112px', height: '4px', margin: isMobile ? '5px 0 8px 0' : '5px 0 4px auto', overflow: 'hidden', borderRadius: '999px', background: 'rgba(255,255,255,0.1)' }}><div style={{ height: '100%', background: trialTimeLeft && trialTimeLeft <= 10 ? '#ff2a5f' : '#00f0ff', transformOrigin: 'right center', transform: `scaleX(${trialTimeLeft === null ? 1 : Math.max(0, Math.min(1, trialTimeLeft / TRIAL_DURATION_SECONDS))})`, transition: 'transform 1s linear, background-color 250ms ease', willChange: 'transform' }} /></div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', justifyContent: isMobile ? 'flex-start' : 'flex-end' }}>
                          <button onClick={() => selectTrialVote(null)} disabled={isEliminated || isObserver || trialData?.status !== 'voting' || trialData?.confirmedVoterIds?.includes(socket.id)} style={{ marginTop: '6px', padding: '7px 11px', borderRadius: '6px', border: trialDraftTargetId === null ? '1px solid #e2e8f0' : '1px solid rgba(255,255,255,0.16)', background: trialDraftTargetId === null ? 'rgba(255,255,255,0.17)' : 'rgba(255,255,255,0.04)', color: '#e2e8f0', cursor: 'pointer', boxShadow: trialDraftTargetId === null ? '0 0 20px rgba(255,255,255,0.25)' : 'none', animation: trialDraftTargetId === null ? 'trialSkipPulse 900ms ease-in-out infinite' : 'none', transition: 'all 0.25s ease-in-out' }}>⊘ {language === 'ru' ? 'ПРОПУСТИТЬ ГОЛОС' : language === 'uk' ? "ПРОПУСТИТИ ГОЛОС" : language === 'es' ? 'SALTAR VOTO' : language === 'de' ? 'ABSTIMMUNG ÜBERSPRINGEN' : language === 'fr' ? 'PASSER LE VOTE' : 'SKIP VOTE'}</button>
                          <button onClick={() => setIsTrialChatOpen(open => !open)} style={{ marginTop: '6px', marginLeft: isMobile ? 0 : '6px', padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(0,240,255,0.25)', background: 'rgba(0,240,255,0.08)', color: '#8be7ff', cursor: 'pointer' }}>{language === 'ru' ? 'ЧАТ' : language === 'uk' ? "ЧАТ" : language === 'es' ? 'CHAT' : language === 'de' ? 'CHAT' : language === 'fr' ? 'CHAT' : 'CHAT'} ({chatMessages.length})</button>
                          <button onClick={handleOpenClues} style={{ marginTop: '6px', marginLeft: isMobile ? 0 : '6px', padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(224,64,251,0.3)', background: 'rgba(224,64,251,0.08)', color: '#e29bff', cursor: 'pointer' }}>{language === 'ru' ? 'УЛИКИ' : language === 'uk' ? "ДОКАЗИ" : language === 'es' ? 'PRUEBAS' : language === 'de' ? 'BEWEISE' : language === 'fr' ? 'INDICES' : 'CLUES'} ({clues.length})</button>
                          <button onClick={handleOpenBodies} style={{ marginTop: '6px', marginLeft: isMobile ? 0 : '6px', padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(255,143,168,0.3)', background: 'rgba(255,143,168,0.08)', color: '#ff8fa8', cursor: 'pointer' }}>{language === 'ru' ? 'ТЕЛА' : language === 'uk' ? "ТІЛА" : language === 'es' ? 'CUERPOS' : language === 'de' ? 'LEICHEN' : language === 'fr' ? 'CORPS' : 'BODIES'} ({(trialFindings?.bodies || []).length})</button>
                          </div>
                        </div>
                      </div>

                      <p style={{ margin: '0 0 16px 0', color: '#bdc7db', lineHeight: 1.6 }}>
                        {language === 'ru'
                          ? 'Совещайтесь. Единственный подозреваемый с наибольшим числом голосов будет устранён; ничья или ничья с голосами «Пропустить» не приводит к устранению.'
                          : language === 'uk' ? "Радьтеся. Єдиний підозрюваний з найбільшою кількістю голосів буде усунений; нічия або нічия з голосами «Пропустити» не призводить до усунення." : language === 'es' ? 'Deliberen. El único sospechoso con más votos será eliminado; un empate, o un empate con Abstenerse, no provoca eliminación alguna.' : language === 'de' ? 'Beratet euch. Der einzige Verdächtige mit den meisten Stimmen wird ausgeschaltet; ein Gleichstand oder ein Gleichstand mit Enthaltung führt zu keiner Ausschaltung.' : language === 'fr' ? "Délibérez. Le seul suspect ayant reçu le plus de votes est éliminé ; toute égalité, y compris avec l'option Passer, empêche une élimination." : 'Deliberate. The sole suspect with the most votes is removed; any tie or Skip vote tie prevents an elimination.'}
                      </p>

                      {isEliminated || isObserver ? (
                        <div style={{ padding: '12px 14px', borderRadius: '12px', border: '1px solid rgba(255,42,95,0.2)', background: 'rgba(255,42,95,0.08)', color: '#ff8da6', marginBottom: '12px' }}>
                          {language === 'ru'
                            ? 'Вы наблюдаете за советом из камер внизу. Ваш голос больше не учитывается.'
                            : language === 'uk' ? "Ви спостерігаєте за радою через камери внизу. Ваш голос більше не враховується." : language === 'es' ? 'Estás observando el consejo desde las celdas de abajo. Tu voto ya no cuenta.' : language === 'de' ? 'Du beobachtest den Rat von den Zellen unten aus. Deine Stimme zählt nicht mehr.' : language === 'fr' ? 'Vous observez le conseil depuis les cellules en contrebas. Votre vote ne compte plus.' : 'You are observing the council from the cells below. Your vote is no longer in play.'}
                        </div>
                      ) : null}

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '9px', maxHeight: isMobile ? '38vh' : 'calc(100vh - 310px)', overflowY: 'auto', paddingRight: '5px', opacity: trialDraftTargetId === null ? 0.5 : 1, transition: 'all 0.25s ease-in-out' }}>
                        {trialPlayers && trialPlayers.length > 0 ? trialPlayers.map((player, index) => {
                          const playerCharacter = CHARACTERS.find((char) => char.name === player.character);
                          const isSelf = player.id === socket.id;
                          const playerIsEliminated = Boolean(player.isEliminated || player.isObserver);
                          const isConfirmed = trialData?.confirmedVoterIds?.includes(player.id);
                          // The Joker is exempt from the usual "can't vote for
                          // yourself" rule — every other role still can't (see
                          // matching exception in 'confirm_vote' on the server).
                          const canVote = !isEliminated && !isObserver && (!isSelf || myRole === 'Joker') && !playerIsEliminated && trialData?.status === 'voting' && !trialData?.confirmedVoterIds?.includes(socket.id);
                          // Detective's special action: only ever shown to the
                          // Detective themself, only while actually able to act
                          // (not eliminated/observing), only against a
                          // still-active suspect (checking an eliminated
                          // player's stale pre-elimination location isn't
                          // useful), and never against themselves — the
                          // Detective already knows where they are (server
                          // rejects this too, see 'detective_check_location').
                          const showDetectiveAction = myRole === 'Detective' && !isEliminated && !isObserver && !playerIsEliminated && !isSelf;
                          // Officer's special action: shown to the Officer
                          // themself against ANY still-active suspect —
                          // including their own row (isSelf), since unlike the
                          // Detective the Officer may lock themselves into the
                          // Holding Cell too (server allows this too, see
                          // 'officer_lock_player').
                          const showOfficerAction = myRole === 'Officer' && !isEliminated && !isObserver && !playerIsEliminated;

                          return (
                            <TrialPlayerRow
                              key={player.id}
                              player={player}
                              playerCharacter={playerCharacter}
                              isEliminated={playerIsEliminated}
                              isConfirmed={isConfirmed}
                              isDraft={trialDraftTargetId === player.id}
                              canVote={canVote}
                              onVote={() => selectTrialVote(player.id)}
                              onCheck={() => setSelectedTrialPlayer(player)}
                              index={index}
                              showDetectiveAction={showDetectiveAction}
                              detectiveAvailable={detectiveAbilityStatus?.available !== false}
                              detectiveTurnsRemaining={detectiveAbilityStatus?.turnsRemaining || 0}
                              onDetectiveCheck={() => handleDetectiveCheck(player.id)}
                              showOfficerAction={showOfficerAction}
                              officerAvailable={officerAbilityStatus?.available !== false}
                              officerTurnsRemaining={officerAbilityStatus?.turnsRemaining || 0}
                              onOfficerLock={() => handleOfficerLock(player.id)}
                              isSelf={isSelf}
                              language={language}
                            />
                          );
                        }) : <p style={{ margin: '8px 0', color: '#6272a4', fontSize: '12px' }}>{language === 'ru' ? 'Загрузка зашифрованных профилей агентов...' : language === 'uk' ? "Завантаження зашифрованих профілів агентів..." : language === 'es' ? 'Cargando perfiles cifrados de agentes...' : language === 'de' ? 'Verschlüsselte Agentenprofile werden geladen...' : language === 'fr' ? "Chargement des profils d'agents chiffrés..." : 'Loading encrypted agent profiles...'}</p>}
                      </div>

                      {!isEliminated && !isObserver && trialData?.status === 'voting' && (
                        <div style={{ display: 'flex', gap: '8px', marginTop: '12px', alignItems: 'center' }}>
                          {trialData.confirmedVoterIds?.includes(socket.id) ? (
                            <><span style={{ flex: 1, color: '#76ffb4', fontSize: '11px', fontWeight: 800, letterSpacing: '1px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}><Icon name="check" size={13} />{language === 'ru' ? 'ГОЛОС ЗАФИКСИРОВАН' : language === 'uk' ? "ГОЛОС ЗАФІКСОВАНО" : language === 'es' ? 'VOTO CONFIRMADO' : language === 'de' ? 'STIMME BESTÄTIGT' : language === 'fr' ? 'VOTE VERROUILLÉ' : 'VOTE LOCKED'}</span><button onClick={unlockTrialVote} style={{ padding: '9px 12px', borderRadius: '8px', border: '1px solid rgba(255,191,105,0.5)', background: 'rgba(255,191,105,0.1)', color: '#ffd28e', fontWeight: 800, cursor: 'pointer', transition: 'all 0.25s ease-in-out' }}>{language === 'ru' ? 'ИЗМЕНИТЬ ГОЛОС' : language === 'uk' ? "ЗМІНИТИ ГОЛОС" : language === 'es' ? 'CAMBIAR VOTO' : language === 'de' ? 'STIMME ÄNDERN' : language === 'fr' ? 'CHANGER DE VOTE' : 'CHANGE VOTE'}</button></>
                          ) : trialDraftTargetId !== undefined ? (
                            <><button onClick={confirmTrialVote} style={{ flex: 1, padding: '10px 12px', borderRadius: '8px', border: '1px solid #00ff87', background: 'rgba(0,255,135,0.16)', color: '#76ffb4', fontWeight: 900, cursor: 'pointer', boxShadow: '0 0 18px rgba(0,255,135,0.15)', transition: 'all 0.25s ease-in-out' }}>{language === 'ru' ? 'ПОДТВЕРДИТЬ ГОЛОС' : language === 'uk' ? "ПІДТВЕРДИТИ ГОЛОС" : language === 'es' ? 'CONFIRMAR VOTO' : language === 'de' ? 'STIMME BESTÄTIGEN' : language === 'fr' ? 'CONFIRMER LE VOTE' : 'CONFIRM VOTE'}</button><button onClick={() => setTrialDraftTargetId(undefined)} style={{ padding: '10px 12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.04)', color: '#c9d3e0', fontWeight: 800, cursor: 'pointer', transition: 'all 0.25s ease-in-out' }}>{language === 'ru' ? 'СБРОСИТЬ / ИЗМЕНИТЬ' : language === 'uk' ? "СКИНУТИ / ЗМІНИТИ" : language === 'es' ? 'RESTABLECER / CAMBIAR' : language === 'de' ? 'ZURÜCKSETZEN / ÄNDERN' : language === 'fr' ? 'RÉINITIALISER / MODIFIER' : 'RESET / CHANGE'}</button></>
                          ) : <span style={{ color: '#8a99ad', fontSize: '11px', letterSpacing: '1px' }}>{language === 'ru' ? 'ВЫБЕРИТЕ ПОДОЗРЕВАЕМОГО ИЛИ ВОЗДЕРЖИТЕСЬ, ЗАТЕМ ЗАФИКСИРУЙТЕ ГОЛОС' : language === 'uk' ? "ОБЕРІТЬ ПІДОЗРЮВАНОГО АБО УТРИМАЙТЕСЯ, ПОТІМ ЗАФІКСУЙТЕ ГОЛОС" : language === 'es' ? 'ELIGE UN SOSPECHOSO O ABSTENTE, LUEGO CONFIRMA TU VOTO' : language === 'de' ? 'WÄHLE EINEN VERDÄCHTIGEN ODER ENTHALTE DICH, DANN BESTÄTIGE DEINE STIMME' : language === 'fr' ? "SÉLECTIONNEZ UN SUSPECT OU ABSTENEZ-VOUS, PUIS VERROUILLEZ VOTRE VOTE" : 'SELECT A SUSPECT OR ABSTAIN, THEN LOCK YOUR VOTE'}</span>}
                        </div>
                      )}

                      {/* Override Terminal: Innocent-only, lets the team attempt an instant
                          win by submitting the fully-assembled code. The collected fragments
                          themselves are shown in exactly one place — the HUD in the top-right
                          corner — so this panel just points there instead of repeating them. */}
                      {myRole === 'Innocent' && !isEliminated && !isObserver && trialData?.status === 'voting' && (
                        <div style={{
                          marginTop: '14px',
                          padding: '14px',
                          borderRadius: '12px',
                          border: `1px solid ${exitSealed ? 'rgba(255,42,95,0.35)' : 'rgba(0,255,135,0.3)'}`,
                          background: exitSealed ? 'rgba(255,42,95,0.06)' : 'rgba(0,255,135,0.06)'
                        }}>
                          <div style={{ fontSize: '11px', letterSpacing: '2px', color: exitSealed ? '#ff2a5f' : '#76ffb4', marginBottom: '4px' }}>
                            {language === 'ru' ? 'ТЕРМИНАЛ ОТМЕНЫ — ВВЕДИТЕ КОД, ЧТОБЫ ЗАВЕРШИТЬ ИГРУ' : language === 'uk' ? "ТЕРМІНАЛ СКАСУВАННЯ — ВВЕДІТЬ КОД, ЩОБ ЗАВЕРШИТИ ГРУ" : language === 'es' ? 'TERMINAL DE ANULACIÓN — INTRODUCE EL CÓDIGO PARA TERMINAR LA PARTIDA' : language === 'de' ? 'AUFHEBUNGSTERMINAL — GIB DEN CODE EIN, UM DAS SPIEL ZU BEENDEN' : language === 'fr' ? 'TERMINAL DE REMPLACEMENT — SOUMETTEZ LE CODE POUR TERMINER LA PARTIE' : 'OVERRIDE TERMINAL — SUBMIT THE CODE TO END THE MATCH'}
                          </div>
                          {exitSealed ? (
                            <div style={{ fontSize: '10px', letterSpacing: '0.5px', color: '#ff8fa8', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <Icon name="lock" size={12} /> {language === 'ru' ? 'ЗАБЛОКИРОВАНО — где-то ещё осталось непроверенное тело.' : language === 'uk' ? "ЗАБЛОКОВАНО — десь ще залишилося неперевірене тіло." : language === 'es' ? 'SELLADO — todavía queda un cuerpo sin examinar en algún lugar.' : language === 'de' ? 'VERSIEGELT — irgendwo ist noch eine unentdeckte Leiche.' : language === 'fr' ? 'SCELLÉ — un corps reste introuvable quelque part.' : 'SEALED — a body is still out there, unaccounted for.'}
                            </div>
                          ) : (
                            <div style={{ fontSize: '10px', letterSpacing: '0.5px', color: '#8a99ad', marginBottom: '10px' }}>
                              {language === 'ru' ? 'Проверьте собранные цифры в верхнем правом углу.' : language === 'uk' ? "Перевірте зібрані цифри у верхньому правому куті." : language === 'es' ? 'Comprueba los dígitos recogidos en la esquina superior derecha.' : language === 'de' ? 'Überprüfe die gesammelten Ziffern oben rechts.' : language === 'fr' ? 'Consultez les chiffres collectés dans le coin supérieur droit.' : 'Check your collected digits in the top-right corner.'}
                            </div>
                          )}

                          <form
                            onSubmit={(e) => { e.preventDefault(); if (!exitSealed) handleSubmitInnocentCode(); }}
                            style={{ display: 'flex', gap: '8px' }}
                          >
                            <input
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              autoComplete="off"
                              maxLength={codeTotalDigits || undefined}
                              value={codeGuess}
                              disabled={exitSealed}
                              onChange={(e) => setCodeGuess(e.target.value.replace(/[^0-9]/g, ''))}
                              placeholder={exitSealed ? (language === 'ru' ? 'ВЫХОД ЗАБЛОКИРОВАН' : language === 'uk' ? "ВИХІД ЗАБЛОКОВАНО" : language === 'es' ? 'SALIDA BLOQUEADA' : language === 'de' ? 'AUSGANG GESPERRT' : language === 'fr' ? 'SORTIE SCELLÉE' : 'EXIT SEALED') : (language === 'ru' ? 'ВВЕДИТЕ КОД ОТМЕНЫ' : language === 'uk' ? "ВВЕДІТЬ КОД СКАСУВАННЯ" : language === 'es' ? 'INTRODUCE EL CÓDIGO DE ANULACIÓN' : language === 'de' ? 'AUFHEBUNGSCODE EINGEBEN' : language === 'fr' ? 'ENTREZ LE CODE DE REMPLACEMENT' : 'ENTER OVERRIDE CODE')}
                              style={{
                                flex: '1 1 auto',
                                minWidth: 0,
                                padding: '10px 12px',
                                borderRadius: '8px',
                                border: `1px solid ${exitSealed ? 'rgba(255,42,95,0.3)' : 'rgba(0,255,135,0.3)'}`,
                                background: '#050705',
                                color: exitSealed ? '#8a99ad' : '#e2e8f0',
                                fontSize: '16px',
                                letterSpacing: '3px',
                                fontFamily: 'Georgia, serif',
                                opacity: exitSealed ? 0.6 : 1
                              }}
                            />
                            <NeonButton
                              type="submit"
                              variant={exitSealed ? 'danger' : 'success'}
                              disabled={exitSealed || !codeGuess.trim()}
                              style={{ width: 'auto', flex: '0 0 auto', marginBottom: 0, padding: '10px 16px' }}
                            >
                              {exitSealed ? (language === 'ru' ? 'ЗАБЛОКИРОВАНО' : language === 'uk' ? "ЗАБЛОКОВАНО" : language === 'es' ? 'BLOQUEADO' : language === 'de' ? 'GESPERRT' : language === 'fr' ? 'SCELLÉ' : 'SEALED') : (language === 'ru' ? 'ОТПРАВИТЬ КОД' : language === 'uk' ? "НАДІСЛАТИ КОД" : language === 'es' ? 'ENVIAR CÓDIGO' : language === 'de' ? 'CODE SENDEN' : language === 'fr' ? 'SOUMETTRE LE CODE' : 'SUBMIT CODE')}
                            </NeonButton>
                          </form>
                        </div>
                      )}

                      {trialData?.result && (
                        <div style={{ marginTop: '14px', padding: '12px 14px', borderRadius: '12px', border: '1px solid rgba(0,255,135,0.2)', background: 'rgba(0,255,135,0.08)', color: '#76ffb4', animation: 'verdictEnter 620ms cubic-bezier(0.16, 1, 0.3, 1) both' }}>
                          {translateTrialResultMessage(trialData.result, language)}
                        </div>
                      )}
                    </div>

                    <div style={{
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: isMobile ? '14px' : '18px',
                      padding: isMobile ? '10px' : '14px',
                      background: 'rgba(255,255,255,0.03)',
                      display: 'flex', flexDirection: 'column', gap: '14px', minHeight: isMobile ? 'auto' : '320px'
                    }}>
                      <div style={{ fontSize: '11px', letterSpacing: '2px', color: '#8a99ad' }}>{language === 'ru' ? 'ДОСЬЕ БАЗЫ ДАННЫХ' : language === 'uk' ? "ДОСЬЄ БАЗИ ДАНИХ" : language === 'es' ? 'EXPEDIENTE DE LA BASE DE DATOS' : language === 'de' ? 'DATENBANKAKTE' : language === 'fr' ? 'DOSSIER DE LA BASE DE DONNÉES' : 'DATABASE DOSSIER'}</div>
                      {selectedTrialPlayer ? (() => {
                        const character = CHARACTERS.find(({ name }) => name === selectedTrialPlayer.character);
                        const dossier = character;
                        // On mobile the side-by-side 150px/180px min-width grid
                        // (330px minimum) no longer fit inside a phone-width
                        // dossier panel and squeezed the photo and every stat
                        // line down to unreadable slivers. Below the breakpoint,
                        // stack the photo above the text as a single column and
                        // cap the photo height so the stats stay in easy reach
                        // without excessive scrolling.
                        return <div style={{ display: isMobile ? 'flex' : 'grid', flexDirection: isMobile ? 'column' : undefined, gridTemplateColumns: isMobile ? undefined : 'minmax(150px, 0.9fr) minmax(180px, 1.1fr)', gap: '14px', alignItems: isMobile ? 'stretch' : 'start' }}>
                          <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.25)', borderRadius: '10px', padding: '8px' }}>
                            {character?.url && <img src={character.url} alt={character.name} style={{ display: 'block', width: '100%', maxWidth: '100%', maxHeight: isMobile ? '34vh' : 'min(58vh, 520px)', objectFit: 'contain', borderRadius: '7px' }} />}
                          </div>
                          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
                          <div style={{ fontSize: isMobile ? '19px' : '24px', fontWeight: 900, color: '#fff' }}>{selectedTrialPlayer.nickname}</div>
                          <div style={{ fontSize: '11px', color: '#00f0ff', letterSpacing: '1px' }}>{character?.name?.toUpperCase() || (language === 'ru' ? 'НЕИЗВЕСТНЫЙ АГЕНТ' : language === 'uk' ? "НЕВІДОМИЙ АГЕНТ" : language === 'es' ? 'AGENTE DESCONOCIDO' : language === 'de' ? 'UNBEKANNTER AGENT' : language === 'fr' ? 'AGENT INCONNU' : 'UNKNOWN AGENT')}</div>
                          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '8px', fontSize: isMobile ? '12px' : '11px', color: '#c9d3e0', lineHeight: 1.5 }}>
                            <span>{language === 'ru' ? 'НАСТОЯЩЕЕ ИМЯ' : language === 'uk' ? "СПРАВЖНЄ ІМ'Я" : language === 'es' ? 'NOMBRE REAL' : language === 'de' ? 'ECHTER NAME' : language === 'fr' ? 'VRAI NOM' : 'REAL NAME'}: {dossier?.realName || (language === 'ru' ? 'ЗАСЕКРЕЧЕНО' : language === 'uk' ? "ЗАСЕКРЕЧЕНО" : language === 'es' ? 'CLASIFICADO' : language === 'de' ? 'GEHEIM' : language === 'fr' ? 'CLASSIFIÉ' : 'CLASSIFIED')}</span><span>{language === 'ru' ? 'РОСТ' : language === 'uk' ? "ЗРІСТ" : language === 'es' ? 'ALTURA' : language === 'de' ? 'GRÖSSE' : language === 'fr' ? 'TAILLE' : 'HEIGHT'}: {dossier?.height || '—'}</span>
                            <span>{language === 'ru' ? 'ВЕС' : language === 'uk' ? "ВАГА" : language === 'es' ? 'PESO' : language === 'de' ? 'GEWICHT' : language === 'fr' ? 'POIDS' : 'WEIGHT'}: {dossier?.weight || '—'}</span><span>{language === 'ru' ? 'ГРУППА КРОВИ' : language === 'uk' ? "ГРУПА КРОВІ" : language === 'es' ? 'GRUPO SANGUÍNEO' : language === 'de' ? 'BLUTGRUPPE' : language === 'fr' ? 'SANG' : 'BLOOD'}: {dossier?.bloodType || '—'}</span>
                            <span style={{ gridColumn: isMobile ? 'auto' : '1 / -1' }}>{language === 'ru' ? 'УВЛЕЧЕНИЯ' : language === 'uk' ? "ЗАХОПЛЕННЯ" : language === 'es' ? 'AFICIONES' : language === 'de' ? 'HOBBYS' : language === 'fr' ? 'LOISIRS' : 'HOBBIES'}: {translateHobbies(character?.name, dossier?.hobbies, language) || '—'}</span>
                          </div>
                          </div>
                        </div>;
                      })() : <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: '#6272a4', letterSpacing: '2px', fontSize: '13px' }}>{language === 'ru' ? 'ВЫБЕРИТЕ АГЕНТА ДЛЯ РАССЛЕДОВАНИЯ' : language === 'uk' ? "ОБЕРІТЬ АГЕНТА ДЛЯ РОЗСЛІДУВАННЯ" : language === 'es' ? 'SELECCIONA UN AGENTE PARA INVESTIGAR' : language === 'de' ? 'WÄHLE EINEN AGENTEN ZUM UNTERSUCHEN' : language === 'fr' ? 'SÉLECTIONNEZ UN AGENT À ENQUÊTER' : 'SELECT AN AGENT TO INVESTIGATE'}</div>}
                    </div>
                  </div>
                </div>
              )}
              {/* Detective's private investigation result. This state is only ever
                  populated by the 'detective_check_result' event, which the server
                  emits ONLY to the requesting Detective's own socket — no other
                  player's client ever receives this, so this popup can never
                  render for anyone else. */}
              {displayPhase === 'trial' && detectiveCheckResult && (
                <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)' }} onClick={() => setDetectiveCheckResult(null)}>
                  <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(360px, calc(100vw - 40px))', padding: '20px', borderRadius: '14px', border: '1px solid rgba(224,64,251,0.4)', background: '#0a0a0f', boxShadow: '0 0 40px rgba(224,64,251,0.25)', animation: 'verdictEnter 420ms cubic-bezier(0.16, 1, 0.3, 1) both' }}>
                    <div style={{ fontSize: '10px', letterSpacing: '2px', color: '#e29bff', marginBottom: '8px' }}>🔍 {language === 'ru' ? 'КОНФИДЕНЦИАЛЬНО — ТОЛЬКО ДЛЯ ДЕТЕКТИВА' : language === 'uk' ? "КОНФІДЕНЦІЙНО — ЛИШЕ ДЛЯ ДЕТЕКТИВА" : language === 'es' ? 'CONFIDENCIAL — SOLO PARA EL DETECTIVE' : language === 'de' ? 'VERTRAULICH — NUR FÜR DEN DETEKTIV' : language === 'fr' ? 'CONFIDENTIEL — RÉSERVÉ AU DÉTECTIVE' : 'CONFIDENTIAL — DETECTIVE EYES ONLY'}</div>
                    <div style={{ color: '#e2e8f0', lineHeight: 1.6, fontSize: '14px' }}>
                      <strong>{detectiveCheckResult.targetNickname}</strong> {language === 'ru' ? 'завершил свой последний ход в:' : language === 'uk' ? "завершив свій останній хід у:" : language === 'es' ? 'terminó su último turno en:' : language === 'de' ? 'beendete seinen letzten Zug in:' : language === 'fr' ? 'a terminé son dernier tour dans :' : 'ended their last turn in:'} <strong style={{ color: '#e29bff' }}>{translateRoomName(detectiveCheckResult.roomName, language)}</strong>
                    </div>
                    <button onClick={() => setDetectiveCheckResult(null)} style={{ marginTop: '16px', width: '100%', padding: '9px', borderRadius: '8px', border: '1px solid rgba(224,64,251,0.4)', background: 'rgba(224,64,251,0.1)', color: '#e29bff', fontWeight: 800, cursor: 'pointer' }}>{language === 'ru' ? 'ЗАКРЫТЬ' : language === 'uk' ? "ЗАКРИТИ" : language === 'es' ? 'CERRAR' : language === 'de' ? 'SCHLIESSEN' : language === 'fr' ? 'FERMER' : 'CLOSE'}</button>
                  </div>
                </div>
              )}
              {/* Officer's private detainment confirmation. This state is only
                  ever populated by the 'officer_lock_result' event, which the
                  server emits ONLY to the requesting Officer's own socket —
                  no other player's client ever receives this. Unlike the
                  Detective's popup above, this is just a scheduling
                  confirmation: the target doesn't actually get locked until
                  the NEXT round starts (see 'round_start's public
                  lockedInHoldingCell), at which point everyone learns it. */}
              {displayPhase === 'trial' && officerLockResult && (
                <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)' }} onClick={() => setOfficerLockResult(null)}>
                  <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(360px, calc(100vw - 40px))', padding: '20px', borderRadius: '14px', border: '1px solid rgba(0,240,255,0.4)', background: '#0a0a0f', boxShadow: '0 0 40px rgba(0,240,255,0.25)', animation: 'verdictEnter 420ms cubic-bezier(0.16, 1, 0.3, 1) both' }}>
                    <div style={{ fontSize: '10px', letterSpacing: '2px', color: '#8be7ff', marginBottom: '8px' }}>🔒 {language === 'ru' ? 'КОНФИДЕНЦИАЛЬНО — ТОЛЬКО ДЛЯ ОФИЦЕРА' : language === 'uk' ? "КОНФІДЕНЦІЙНО — ЛИШЕ ДЛЯ ОФІЦЕРА" : language === 'es' ? 'CONFIDENCIAL — SOLO PARA EL OFICIAL' : language === 'de' ? 'VERTRAULICH — NUR FÜR DEN OFFIZIER' : language === 'fr' ? "CONFIDENTIEL — RÉSERVÉ À L'AGENT DE POLICE" : 'CONFIDENTIAL — OFFICER EYES ONLY'}</div>
                    <div style={{ color: '#e2e8f0', lineHeight: 1.6, fontSize: '14px' }}>
                      <strong>{officerLockResult.targetNickname}</strong> {language === 'ru' ? 'будет заперт в' : language === 'uk' ? "буде замкнений у" : language === 'es' ? 'quedará encerrado en' : language === 'de' ? 'wird eingesperrt in' : language === 'fr' ? 'sera enfermé(e) dans la' : 'will be locked in the'} <strong style={{ color: '#8be7ff' }}>{language === 'ru' ? 'Камере' : language === 'uk' ? "Камері" : language === 'es' ? 'la Celda' : language === 'de' ? 'der Zelle' : language === 'fr' ? 'Cellule de détention' : 'Holding Cell'}</strong> {language === 'ru' ? 'на весь следующий раунд.' : language === 'uk' ? "на весь наступний раунд." : language === 'es' ? 'durante toda la próxima ronda.' : language === 'de' ? 'für die gesamte nächste Runde.' : language === 'fr' ? 'pour tout le round suivant.' : 'for the entirety of next round.'}
                    </div>
                    <button onClick={() => setOfficerLockResult(null)} style={{ marginTop: '16px', width: '100%', padding: '9px', borderRadius: '8px', border: '1px solid rgba(0,240,255,0.4)', background: 'rgba(0,240,255,0.1)', color: '#8be7ff', fontWeight: 800, cursor: 'pointer' }}>{language === 'ru' ? 'ЗАКРЫТЬ' : language === 'uk' ? "ЗАКРИТИ" : language === 'es' ? 'CERRAR' : language === 'de' ? 'SCHLIESSEN' : language === 'fr' ? 'FERMER' : 'CLOSE'}</button>
                  </div>
                </div>
              )}
              {displayPhase === 'trial' && isTrialChatOpen && (
                <aside style={{ position: 'fixed', top: '18px', right: '18px', bottom: `${18 + bottomInset}px`, zIndex: 30, width: 'min(340px, calc(100vw - 36px))', padding: '14px', borderRadius: '12px', border: '1px solid rgba(0,240,255,0.25)', background: 'rgba(5,8,16,0.98)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: '#8be7ff', fontSize: '11px', letterSpacing: '1px' }}><span>{language === 'ru' ? 'ТАКТИЧЕСКИЙ ЧАТ' : language === 'uk' ? "ТАКТИЧНИЙ ЧАТ" : language === 'es' ? 'CHAT TÁCTICO' : language === 'de' ? 'TAKTIK-CHAT' : language === 'fr' ? 'CHAT TACTIQUE' : 'TACTICAL CHAT'}</span><button onClick={() => setIsTrialChatOpen(false)} style={{ color: '#8be7ff', background: 'transparent', border: 0, cursor: 'pointer' }}>{language === 'ru' ? 'ЗАКРЫТЬ' : language === 'uk' ? "ЗАКРИТИ" : language === 'es' ? 'CERRAR' : language === 'de' ? 'SCHLIESSEN' : language === 'fr' ? 'FERMER' : 'CLOSE'}</button></div>
                  <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>{chatMessages.map(message => <div key={message.id} style={{ padding: '8px', borderRadius: '8px', background: 'rgba(255,255,255,0.04)', fontSize: '12px' }}><div style={{ color: '#00f0ff', fontSize: '10px' }}>{message.senderNickname}</div>{message.text}</div>)}</div>
                  {(isEliminated || isObserver) && <div style={{ padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,42,95,0.35)', background: 'rgba(255,42,95,0.08)', color: '#ff9caf', fontSize: '11px', lineHeight: 1.45, transition: 'all 0.3s ease' }}>{language === 'ru' ? 'ВЫ УСТРАНЕНЫ И НЕ МОЖЕТЕ УЧАСТВОВАТЬ В ОБСУЖДЕНИЯХ ИЛИ ГОЛОСОВАНИИ СУДА.' : language === 'uk' ? "ВИ УСУНЕНІ Й НЕ МОЖЕТЕ БРАТИ УЧАСТЬ В ОБГОВОРЕННЯХ АБО ГОЛОСУВАННІ СУДУ." : language === 'es' ? 'HAS SIDO ELIMINADO Y NO PUEDES PARTICIPAR EN LOS DEBATES NI EN LA VOTACIÓN DEL JUICIO.' : language === 'de' ? 'DU WURDEST AUSGESCHALTET UND KANNST NICHT AN DEN DEBATTEN ODER DER ABSTIMMUNG DES PROZESSES TEILNEHMEN.' : language === 'fr' ? 'VOUS ÊTES ÉLIMINÉ(E) ET NE POUVEZ PAS PARTICIPER AUX DISCUSSIONS NI AU VOTE DU PROCÈS.' : 'YOU ARE ELIMINATED AND CANNOT PARTICIPATE IN TRIAL DISCUSSIONS OR VOTING.'}</div>}
                  <form onSubmit={handleSendChatMessage} style={{ display: 'flex', gap: '6px' }}><input disabled={isEliminated || isObserver} value={draftChatMessage} onChange={(e) => setDraftChatMessage(e.target.value)} placeholder={isEliminated || isObserver ? (language === 'ru' ? 'Чат суда заблокирован для наблюдателей' : language === 'uk' ? "Чат суду заблоковано для спостерігачів" : language === 'es' ? 'El chat del juicio está bloqueado para los espectadores' : language === 'de' ? 'Der Prozess-Chat ist für Beobachter gesperrt' : language === 'fr' ? 'Chat du procès verrouillé pour les spectateurs' : 'Trial chat locked for spectators') : (language === 'ru' ? 'Отправить сообщение' : language === 'uk' ? "Надіслати повідомлення" : language === 'es' ? 'Enviar un mensaje' : language === 'de' ? 'Eine Nachricht senden' : language === 'fr' ? 'Envoyer un message' : 'Send a message')} style={{ minWidth: 0, flex: 1, padding: '8px', minHeight: '40px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.12)', background: '#0a0a0f', color: '#fff', fontSize: '16px', opacity: isEliminated || isObserver ? 0.45 : 1, transition: 'all 0.3s ease' }} /><button disabled={isEliminated || isObserver} type="submit" style={{ borderRadius: '6px', border: '1px solid rgba(0,240,255,0.3)', background: 'rgba(0,240,255,0.08)', color: '#8be7ff', padding: '8px 14px', minHeight: '40px', minWidth: '56px', opacity: isEliminated || isObserver ? 0.45 : 1 }}>{language === 'ru' ? 'ОТПРАВИТЬ' : language === 'uk' ? "НАДІСЛАТИ" : language === 'es' ? 'ENVIAR' : language === 'de' ? 'SENDEN' : language === 'fr' ? 'ENVOYER' : 'SEND'}</button></form>
                </aside>
              )}
              {/* Shared CLUES board — every piece of physical evidence anyone has
                  actually found via INVESTIGATE ROOM, deduplicated by clue id (see
                  'clues_board_update'). Deliberately independent of the digital
                  code fragments, which stay Innocent-only exactly as before. */}
              {displayPhase === 'trial' && isCluesOpen && (
                <aside style={{ position: 'fixed', top: '18px', right: '18px', bottom: `${18 + bottomInset}px`, zIndex: 30, width: 'min(340px, calc(100vw - 36px))', padding: '14px', borderRadius: '12px', border: '1px solid rgba(224,64,251,0.3)', background: 'rgba(5,8,16,0.98)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {(() => {
                    const selectedClue = selectedClueId ? clues.find(c => c.id === selectedClueId) : null;
                    if (selectedClue) {
                      return (
                        <>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#e29bff', fontSize: '11px', letterSpacing: '1px' }}>
                            <button onClick={handleBackToCluesList} style={{ color: '#e29bff', background: 'transparent', border: 0, cursor: 'pointer', padding: 0, fontSize: '11px' }}>‹ {language === 'ru' ? 'НАЗАД' : language === 'uk' ? "НАЗАД" : language === 'es' ? 'ATRÁS' : language === 'de' ? 'ZURÜCK' : language === 'fr' ? 'RETOUR' : 'BACK'}</button>
                            <button onClick={handleCloseClues} style={{ color: '#e29bff', background: 'transparent', border: 0, cursor: 'pointer' }}>{language === 'ru' ? 'ЗАКРЫТЬ' : language === 'uk' ? "ЗАКРИТИ" : language === 'es' ? 'CERRAR' : language === 'de' ? 'SCHLIESSEN' : language === 'fr' ? 'FERMER' : 'CLOSE'}</button>
                          </div>
                          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            <div>
                              <p style={{ margin: '0 0 4px 0', fontSize: '10px', letterSpacing: '2px', color: '#8a99ad' }}>{language === 'ru' ? 'ДОСЬЕ УЛИКИ' : language === 'uk' ? "ДОСЬЄ ДОКАЗУ" : language === 'es' ? 'EXPEDIENTE DE LA PRUEBA' : language === 'de' ? 'BEWEISAKTE' : language === 'fr' ? 'DOSSIER DE PREUVES' : 'EVIDENCE DOSSIER'}</p>
                              <h4 style={{ margin: 0, fontSize: '18px', color: '#e2e8f0' }}>{translateEvidenceName(selectedClue.text, language)}</h4>
                            </div>
                            <div style={{ fontSize: '11px', color: '#8a99ad', letterSpacing: '1px' }}>
                              {language === 'ru' ? 'НАЙДЕНО В:' : language === 'uk' ? "ЗНАЙДЕНО В:" : language === 'es' ? 'ENCONTRADO EN:' : language === 'de' ? 'GEFUNDEN IN:' : language === 'fr' ? 'TROUVÉ DANS :' : 'FOUND IN:'} <span style={{ color: '#e2e8f0' }}>{translateRoomName(selectedClue.roomName, language)}</span>
                            </div>
                            <div style={{ fontSize: '11px', color: '#8a99ad', letterSpacing: '1px' }}>
                              {language === 'ru' ? 'НАЙДЕНО:' : language === 'uk' ? "ЗНАЙДЕНО:" : language === 'es' ? 'ENCONTRADO POR:' : language === 'de' ? 'GEFUNDEN VON:' : language === 'fr' ? 'TROUVÉ PAR :' : 'FOUND BY:'}
                              <div style={{ marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                {selectedClue.foundBy.map((finder, idx) => (
                                  <span key={`${finder.nickname}_${idx}`} style={{ color: '#e2e8f0', fontSize: '12px' }}>
                                    {finder.nickname} <span style={{ color: '#6272a4' }}>({language === 'ru' ? `Раунд ${finder.round}` : language === 'uk' ? `Раунд ${finder.round}` : language === 'es' ? `Ronda ${finder.round}` : language === 'de' ? `Runde ${finder.round}` : language === 'fr' ? `Round ${finder.round}` : `Round ${finder.round}`})</span>
                                  </span>
                                ))}
                              </div>
                            </div>
                            <div style={{ padding: '10px', borderRadius: '8px', background: 'rgba(255,255,255,0.04)', color: '#bdc7db', fontSize: '12px', lineHeight: 1.55 }}>
                              {translateEvidenceDescription(selectedClue.text, selectedClue.description, language) || (language === 'ru' ? 'Дополнительное описание отсутствует.' : language === 'uk' ? "Додатковий опис відсутній." : language === 'es' ? 'No hay descripción adicional disponible.' : language === 'de' ? 'Keine weitere Beschreibung verfügbar.' : language === 'fr' ? 'Aucune description supplémentaire disponible.' : 'No further description available.')}
                            </div>
                          </div>
                        </>
                      );
                    }
                    return (
                      <>
                        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#e29bff', fontSize: '11px', letterSpacing: '1px' }}><span>{language === 'ru' ? 'УЛИКИ' : language === 'uk' ? "ДОКАЗИ" : language === 'es' ? 'PRUEBAS' : language === 'de' ? 'BEWEISE' : language === 'fr' ? 'INDICES' : 'CLUES'} ({clues.length})</span><button onClick={handleCloseClues} style={{ color: '#e29bff', background: 'transparent', border: 0, cursor: 'pointer' }}>{language === 'ru' ? 'ЗАКРЫТЬ' : language === 'uk' ? "ЗАКРИТИ" : language === 'es' ? 'CERRAR' : language === 'de' ? 'SCHLIESSEN' : language === 'fr' ? 'FERMER' : 'CLOSE'}</button></div>
                        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          {clues.length === 0 && (
                            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: '#6272a4', letterSpacing: '1px', fontSize: '12px', padding: '20px 8px' }}>
                              {language === 'ru' ? 'УЛИКИ ПОКА НЕ НАЙДЕНЫ' : language === 'uk' ? "ДОКАЗИ ПОКИ ЩО НЕ ЗНАЙДЕНІ" : language === 'es' ? 'AÚN NO SE HAN ENCONTRADO PRUEBAS' : language === 'de' ? 'BISHER KEINE BEWEISE GEFUNDEN' : language === 'fr' ? "AUCUNE PREUVE TROUVÉE POUR L'INSTANT" : 'NO EVIDENCE FOUND YET'}
                            </div>
                          )}
                          {clues.map(clue => (
                            <div
                              key={clue.id}
                              style={{ textAlign: 'left', padding: '10px', borderRadius: '8px', border: '1px solid rgba(224,64,251,0.18)', background: 'rgba(255,255,255,0.04)', color: '#e2e8f0', display: 'flex', flexDirection: 'column', gap: '4px' }}
                            >
                              <div
                                onClick={() => handleSelectClue(clue.id)}
                                style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '4px' }}
                              >
                                <span style={{ fontSize: '13px' }}>{translateEvidenceName(clue.text, language)}</span>
                                <span style={{ fontSize: '10px', color: '#8a99ad', letterSpacing: '0.5px' }}>
                                  {translateRoomName(clue.roomName, language)} · {language === 'ru' ? 'найдено:' : language === 'uk' ? "знайдено:" : language === 'es' ? 'encontrado por' : language === 'de' ? 'gefunden von' : language === 'fr' ? 'trouvé par' : 'found by'} {clue.foundBy.map(f => f.nickname).join(', ')}
                                </span>
                              </div>
                              {/* Forensic Examiner only: "Verify Evidence Authenticity" — asks
                                  the server (see handleVerifyEvidence / 'verify_evidence') whether
                                  this specific item is authentic or fabricated/planted. Every
                                  other role never sees this button at all. stopPropagation so
                                  clicking it doesn't also open the dossier detail view above.
                                  Disabled both while a request for THIS clue is in flight and
                                  while the ability itself is on cooldown (forensicVerifyStatus —
                                  once every FORENSIC_VERIFY_COOLDOWN_TURNS of this player's own
                                  turns, same shape as the Joker's PLANT EVIDENCE cooldown). */}
                              {myRole === 'Forensic' && (() => {
                                const isBusy = forensicVerifyingId === clue.id;
                                const onCooldown = forensicVerifyStatus?.available === false;
                                const isDisabled = isBusy || onCooldown;
                                return (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleVerifyEvidence(clue.id); }}
                                    disabled={isDisabled}
                                    style={{
                                      alignSelf: 'flex-start',
                                      marginTop: '2px',
                                      padding: '5px 10px',
                                      borderRadius: '6px',
                                      border: '1px solid rgba(0,240,255,0.3)',
                                      background: 'rgba(0,240,255,0.08)',
                                      color: '#8be7ff',
                                      fontSize: '10px',
                                      fontWeight: 700,
                                      letterSpacing: '1px',
                                      cursor: isDisabled ? 'default' : 'pointer',
                                      opacity: isDisabled ? 0.5 : 1,
                                      transition: 'all 0.2s ease'
                                    }}
                                  >
                                    {isBusy
                                      ? (language === 'ru' ? 'ПРОВЕРКА…' : language === 'uk' ? "ПЕРЕВІРКА…" : language === 'es' ? 'VERIFICANDO…' : language === 'de' ? 'PRÜFE…' : language === 'fr' ? 'VÉRIFICATION…' : 'VERIFYING…')
                                      : onCooldown
                                        ? (language === 'ru'
                                            ? `ПРОВЕРИТЬ (ОСТАЛОСЬ ${forensicVerifyStatus.roundsRemaining} РАУНД${forensicVerifyStatus.roundsRemaining === 1 ? '' : (forensicVerifyStatus.roundsRemaining >= 2 && forensicVerifyStatus.roundsRemaining <= 4 ? 'А' : 'ОВ')})`
                                            : language === 'uk' ? `ПЕРЕВІРИТИ (ЗАЛИШИЛОСЯ ${forensicVerifyStatus.roundsRemaining} ${(forensicVerifyStatus.roundsRemaining === 1 ? 'РАУНД' : (forensicVerifyStatus.roundsRemaining >= 2 && forensicVerifyStatus.roundsRemaining <= 4 ? 'РАУНДИ' : 'РАУНДІВ'))})` : language === 'es' ? `VERIFICAR (QUEDAN ${forensicVerifyStatus.roundsRemaining} RONDA${forensicVerifyStatus.roundsRemaining === 1 ? '' : 'S'})` : language === 'de' ? `PRÜFEN (NOCH ${forensicVerifyStatus.roundsRemaining} RUNDE${forensicVerifyStatus.roundsRemaining === 1 ? '' : 'N'})` : language === 'fr' ? `VÉRIFIER (${forensicVerifyStatus.roundsRemaining} ROUND${forensicVerifyStatus.roundsRemaining === 1 ? '' : 'S'} RESTANT(S))` : `VERIFY (${forensicVerifyStatus.roundsRemaining} ROUND${forensicVerifyStatus.roundsRemaining === 1 ? '' : 'S'} LEFT)`)
                                        : (language === 'ru' ? 'ПРОВЕРИТЬ' : language === 'uk' ? "ПЕРЕВІРИТИ" : language === 'es' ? 'VERIFICAR' : language === 'de' ? 'PRÜFEN' : language === 'fr' ? 'VÉRIFIER' : 'VERIFY')}
                                  </button>
                                );
                              })()}
                            </div>
                          ))}
                        </div>
                      </>
                    );
                  })()}
                </aside>
              )}
              {/* Forensic Examiner's "Verify Evidence Authenticity" result popup
                  (see handleVerifyEvidence / 'verify_evidence_result'). Rendered
                  independently of isCluesOpen so the answer stays visible even
                  if the Evidence panel itself gets closed in the meantime. */}
              {forensicVerifyResult && (
                <ForensicVerifyResultModal
                  evidenceText={translateEvidenceName(forensicVerifyResult.text, language)}
                  isAuthentic={forensicVerifyResult.isAuthentic}
                  onClose={handleCloseForensicResult}
                  language={language}
                />
              )}
              {/* Warning popup for whoever just walked into a trapped room (see
                  'set_trap' / 'trap_triggered'). Rendered independently, same as
                  the Forensic result above, so it stays up regardless of which
                  panel happens to be open when it fires. */}
              {trapTriggeredInfo && (
                <TrapTriggeredModal
                  roomName={trapTriggeredInfo.roomName}
                  onClose={() => setTrapTriggeredInfo(null)}
                  language={language}
                />
              )}
              {forensicBodyExamineResult && (
                <ForensicBodyExaminationModal
                  clue={forensicBodyExamineResult.clue}
                  onClose={handleCloseForensicBodyResult}
                  language={language}
                />
              )}
              {/* BODIES tab — every victim someone has actually discovered so far
                  this match (walked into an exposed body, or an explicit SEARCH
                  FOR BODY; see creditExposedBodyDiscovery / 'search_body' on the
                  server), each with a short flavor description of the scene (see
                  BODY_DESCRIPTIONS / buildFindingsSummary). Sourced from
                  trialFindings, the same one-time recap shown at trial open —
                  a body already found doesn't change again mid-trial, so unlike
                  CLUES there's no live re-fetch on open. */}
              {displayPhase === 'trial' && isBodiesOpen && (
                <aside style={{ position: 'fixed', top: '18px', right: '18px', bottom: `${18 + bottomInset}px`, zIndex: 30, width: 'min(340px, calc(100vw - 36px))', padding: '14px', borderRadius: '12px', border: '1px solid rgba(255,143,168,0.3)', background: 'rgba(5,8,16,0.98)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {(() => {
                    const bodies = trialFindings?.bodies || [];
                    const selectedBody = selectedBodyId ? bodies.find(b => (b.bodyId || b.nickname) === selectedBodyId) : null;
                    if (selectedBody) {
                      return (
                        <>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#ff8fa8', fontSize: '11px', letterSpacing: '1px' }}>
                            <button onClick={handleBackToBodiesList} style={{ color: '#ff8fa8', background: 'transparent', border: 0, cursor: 'pointer', padding: 0, fontSize: '11px' }}>‹ {language === 'ru' ? 'НАЗАД' : language === 'uk' ? "НАЗАД" : language === 'es' ? 'ATRÁS' : language === 'de' ? 'ZURÜCK' : language === 'fr' ? 'RETOUR' : 'BACK'}</button>
                            <button onClick={handleCloseBodies} style={{ color: '#ff8fa8', background: 'transparent', border: 0, cursor: 'pointer' }}>{language === 'ru' ? 'ЗАКРЫТЬ' : language === 'uk' ? "ЗАКРИТИ" : language === 'es' ? 'CERRAR' : language === 'de' ? 'SCHLIESSEN' : language === 'fr' ? 'FERMER' : 'CLOSE'}</button>
                          </div>
                          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            <div>
                              <p style={{ margin: '0 0 4px 0', fontSize: '10px', letterSpacing: '2px', color: '#8a99ad' }}>{language === 'ru' ? 'ТЕЛО' : language === 'uk' ? "ТІЛО" : language === 'es' ? 'CUERPO' : language === 'de' ? 'LEICHE' : language === 'fr' ? 'CORPS' : 'BODY'}</p>
                              <h4 style={{ margin: 0, fontSize: '18px', color: '#e2e8f0' }}>{selectedBody.nickname}</h4>
                            </div>
                            <div style={{ fontSize: '11px', color: '#8a99ad', letterSpacing: '1px' }}>
                              {language === 'ru' ? 'НАЙДЕНО В:' : language === 'uk' ? "ЗНАЙДЕНО В:" : language === 'es' ? 'ENCONTRADO EN:' : language === 'de' ? 'GEFUNDEN IN:' : language === 'fr' ? 'TROUVÉ DANS :' : 'FOUND IN:'} <span style={{ color: '#e2e8f0' }}>{translateRoomName(selectedBody.roomName, language)}</span>
                            </div>
                            <div style={{ fontSize: '11px', color: '#8a99ad', letterSpacing: '1px' }}>
                              {language === 'ru' ? 'НАЙДЕНО:' : language === 'uk' ? "ЗНАЙДЕНО:" : language === 'es' ? 'ENCONTRADO POR:' : language === 'de' ? 'GEFUNDEN VON:' : language === 'fr' ? 'TROUVÉ PAR :' : 'FOUND BY:'}
                              <div style={{ marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                {(selectedBody.foundBy || []).length > 0
                                  ? selectedBody.foundBy.map((nickname, idx) => (
                                    <span key={`${nickname}_${idx}`} style={{ color: '#e2e8f0', fontSize: '12px' }}>{nickname}</span>
                                  ))
                                  : <span style={{ color: '#e2e8f0', fontSize: '12px' }}>{language === 'ru' ? 'Неизвестно' : language === 'uk' ? "Невідомо" : language === 'es' ? 'Desconocido' : language === 'de' ? 'Unbekannt' : language === 'fr' ? 'Inconnu' : 'Unknown'}</span>}
                              </div>
                            </div>
                            {myRole === 'Forensic' && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-start' }}>
                                <button
                                  onClick={() => handleExamineBody(selectedBody.bodyId || selectedBody.nickname)}
                                  disabled={forensicVerifyStatus?.available === false}
                                  style={{
                                    alignSelf: 'flex-start', padding: '7px 10px', borderRadius: '6px', border: '1px solid rgba(0,240,255,0.3)',
                                    background: 'rgba(0,240,255,0.08)', color: '#8be7ff', fontSize: '10px', fontWeight: 800,
                                    letterSpacing: '1px', cursor: forensicVerifyStatus?.available === false ? 'default' : 'pointer', opacity: forensicVerifyStatus?.available === false ? 0.55 : 1
                                  }}
                                >
                                  {forensicVerifyStatus?.available === false
                                    ? (language === 'ru'
                                        ? `ОСМОТРЕТЬ (ОСТАЛОСЬ ${forensicVerifyStatus.roundsRemaining} РАУНД${forensicVerifyStatus.roundsRemaining === 1 ? '' : (forensicVerifyStatus.roundsRemaining >= 2 && forensicVerifyStatus.roundsRemaining <= 4 ? 'А' : 'ОВ')})`
                                        : language === 'uk' ? `ОГЛЯНУТИ (ЗАЛИШИЛОСЯ ${forensicVerifyStatus.roundsRemaining} ${(forensicVerifyStatus.roundsRemaining === 1 ? 'РАУНД' : (forensicVerifyStatus.roundsRemaining >= 2 && forensicVerifyStatus.roundsRemaining <= 4 ? 'РАУНДИ' : 'РАУНДІВ'))})` : language === 'es' ? `EXAMINAR (QUEDAN ${forensicVerifyStatus.roundsRemaining} RONDA${forensicVerifyStatus.roundsRemaining === 1 ? '' : 'S'})` : language === 'de' ? `UNTERSUCHEN (NOCH ${forensicVerifyStatus.roundsRemaining} RUNDE${forensicVerifyStatus.roundsRemaining === 1 ? '' : 'N'})` : language === 'fr' ? `EXAMINER (${forensicVerifyStatus.roundsRemaining} ROUND${forensicVerifyStatus.roundsRemaining === 1 ? '' : 'S'} RESTANT(S))` : `EXAMINE (${forensicVerifyStatus.roundsRemaining} ROUND${forensicVerifyStatus.roundsRemaining === 1 ? '' : 'S'} LEFT)`)
                                    : (language === 'ru' ? 'ОСМОТРЕТЬ ТЕЛО' : language === 'uk' ? "ОГЛЯНУТИ ТІЛО" : language === 'es' ? 'EXAMINAR CUERPO' : language === 'de' ? 'LEICHE UNTERSUCHEN' : language === 'fr' ? 'EXAMINER LE CORPS' : 'EXAMINE BODY')}
                                </button>
                                {forensicReportUnlocked && (
                                  <button
                                    onClick={() => handleViewForensicReport(selectedBody.bodyId || selectedBody.nickname)}
                                    style={{
                                      alignSelf: 'flex-start', padding: '7px 10px', borderRadius: '6px', border: '1px solid rgba(138, 210, 255, 0.3)',
                                      background: 'rgba(138, 210, 255, 0.08)', color: '#a7defe', fontSize: '10px', fontWeight: 800,
                                      letterSpacing: '1px', cursor: 'pointer'
                                    }}
                                  >
                                    {language === 'ru' ? 'СМОТРЕТЬ ОТЧЁТ' : language === 'uk' ? "ПЕРЕГЛЯНУТИ ЗВІТ" : language === 'es' ? 'VER INFORME' : language === 'de' ? 'BERICHT ANSEHEN' : language === 'fr' ? 'VOIR LE RAPPORT' : 'VIEW REPORT'}
                                  </button>
                                )}
                              </div>
                            )}
                            <div style={{ padding: '10px', borderRadius: '8px', background: 'rgba(255,255,255,0.04)', color: '#bdc7db', fontSize: '12px', lineHeight: 1.55 }}>
                              {translateBodyDescription(selectedBody.character, selectedBody.description, language) || (language === 'ru' ? 'На месте происшествия больше ничего не обнаружено.' : language === 'uk' ? "На місці події більше нічого не виявлено." : language === 'es' ? 'No se ha descubierto nada más en la escena.' : language === 'de' ? 'Am Tatort wurde nichts weiter entdeckt.' : language === 'fr' ? 'La scène ne révèle aucun autre détail.' : 'The scene offers no further detail.')}
                            </div>
                          </div>
                        </>
                      );
                    }
                    return (
                      <>
                        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#ff8fa8', fontSize: '11px', letterSpacing: '1px' }}>
                          <span>{language === 'ru' ? 'ТЕЛА' : language === 'uk' ? "ТІЛА" : language === 'es' ? 'CUERPOS' : language === 'de' ? 'LEICHEN' : language === 'fr' ? 'CORPS' : 'BODIES'} ({bodies.length})</span>
                          <button onClick={handleCloseBodies} style={{ color: '#ff8fa8', background: 'transparent', border: 0, cursor: 'pointer' }}>{language === 'ru' ? 'ЗАКРЫТЬ' : language === 'uk' ? "ЗАКРИТИ" : language === 'es' ? 'CERRAR' : language === 'de' ? 'SCHLIESSEN' : language === 'fr' ? 'FERMER' : 'CLOSE'}</button>
                        </div>
                        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          {bodies.length === 0 && (
                            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: '#6272a4', letterSpacing: '1px', fontSize: '12px', padding: '20px 8px' }}>
                              {language === 'ru' ? 'ТЕЛА ПОКА НЕ НАЙДЕНЫ' : language === 'uk' ? "ТІЛА ПОКИ ЩО НЕ ЗНАЙДЕНІ" : language === 'es' ? 'AÚN NO SE HAN ENCONTRADO CUERPOS' : language === 'de' ? 'BISHER KEINE LEICHEN GEFUNDEN' : language === 'fr' ? "AUCUN CORPS TROUVÉ POUR L'INSTANT" : 'NO BODIES FOUND YET'}
                            </div>
                          )}
                          {bodies.map((body, idx) => (
                            <div
                              key={`body-${body.bodyId || body.nickname}-${idx}`}
                              style={{ padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,143,168,0.18)', background: 'rgba(255,255,255,0.04)', color: '#e2e8f0', display: 'flex', flexDirection: 'column', gap: '6px' }}
                            >
                              <div
                                onClick={() => handleSelectBody(body.bodyId || body.nickname)}
                                style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '4px' }}
                              >
                                <span style={{ fontSize: '13px', fontWeight: 700 }}>{body.nickname}</span>
                                <span style={{ fontSize: '10px', color: '#8a99ad', letterSpacing: '0.5px' }}>
                                  {translateRoomName(body.roomName, language)} · {language === 'ru' ? 'найдено:' : language === 'uk' ? "знайдено:" : language === 'es' ? 'encontrado por' : language === 'de' ? 'gefunden von' : language === 'fr' ? 'trouvé par' : 'found by'} {(body.foundBy || []).length > 0 ? body.foundBy.join(', ') : (language === 'ru' ? 'Неизвестно' : language === 'uk' ? "Невідомо" : language === 'es' ? 'Desconocido' : language === 'de' ? 'Unbekannt' : language === 'fr' ? 'Inconnu' : 'Unknown')}
                                </span>
                              </div>
                              {myRole === 'Forensic' && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-start' }}>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleExamineBody(body.bodyId || body.nickname); }}
                                    disabled={forensicVerifyStatus?.available === false}
                                    style={{
                                      alignSelf: 'flex-start', padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(0,240,255,0.3)',
                                      background: 'rgba(0,240,255,0.08)', color: '#8be7ff', fontSize: '10px', fontWeight: 800,
                                      letterSpacing: '1px', cursor: forensicVerifyStatus?.available === false ? 'default' : 'pointer', opacity: forensicVerifyStatus?.available === false ? 0.55 : 1
                                    }}
                                  >
                                    {forensicVerifyStatus?.available === false
                                      ? (language === 'ru'
                                          ? `ОСМОТРЕТЬ (ОСТАЛОСЬ ${forensicVerifyStatus.roundsRemaining} РАУНД${forensicVerifyStatus.roundsRemaining === 1 ? '' : (forensicVerifyStatus.roundsRemaining >= 2 && forensicVerifyStatus.roundsRemaining <= 4 ? 'А' : 'ОВ')})`
                                          : language === 'uk' ? `ОГЛЯНУТИ (ЗАЛИШИЛОСЯ ${forensicVerifyStatus.roundsRemaining} ${(forensicVerifyStatus.roundsRemaining === 1 ? 'РАУНД' : (forensicVerifyStatus.roundsRemaining >= 2 && forensicVerifyStatus.roundsRemaining <= 4 ? 'РАУНДИ' : 'РАУНДІВ'))})` : language === 'es' ? `EXAMINAR (QUEDAN ${forensicVerifyStatus.roundsRemaining} RONDA${forensicVerifyStatus.roundsRemaining === 1 ? '' : 'S'})` : language === 'de' ? `UNTERSUCHEN (NOCH ${forensicVerifyStatus.roundsRemaining} RUNDE${forensicVerifyStatus.roundsRemaining === 1 ? '' : 'N'})` : language === 'fr' ? `EXAMINER (${forensicVerifyStatus.roundsRemaining} ROUND${forensicVerifyStatus.roundsRemaining === 1 ? '' : 'S'} RESTANT(S))` : `EXAMINE (${forensicVerifyStatus.roundsRemaining} ROUND${forensicVerifyStatus.roundsRemaining === 1 ? '' : 'S'} LEFT)`)
                                      : (language === 'ru' ? 'ОСМОТРЕТЬ ТЕЛО' : language === 'uk' ? "ОГЛЯНУТИ ТІЛО" : language === 'es' ? 'EXAMINAR CUERPO' : language === 'de' ? 'LEICHE UNTERSUCHEN' : language === 'fr' ? 'EXAMINER LE CORPS' : 'EXAMINE BODY')}
                                  </button>
                                  {forensicReportUnlocked && (
                                    <button
                                      onClick={(e) => { e.stopPropagation(); handleViewForensicReport(body.bodyId || body.nickname); }}
                                      style={{
                                        alignSelf: 'flex-start', padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(138, 210, 255, 0.3)',
                                        background: 'rgba(138, 210, 255, 0.08)', color: '#a7defe', fontSize: '10px', fontWeight: 800,
                                        letterSpacing: '1px', cursor: 'pointer'
                                      }}
                                    >
                                      {language === 'ru' ? 'СМОТРЕТЬ ОТЧЁТ' : language === 'uk' ? "ПЕРЕГЛЯНУТИ ЗВІТ" : language === 'es' ? 'VER INFORME' : language === 'de' ? 'BERICHT ANSEHEN' : language === 'fr' ? 'VOIR LE RAPPORT' : 'VIEW REPORT'}
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </>
                    );
                  })()}
                </aside>
              )}
            </div>
          )}
        </div>
      )}

      {/* GAME_OVER summary: shown once the server declares a winner — either
          the Innocents cracking the code or the Joker being executed by the
          council during a trial (see 'game_over'). The server alone owns the
          return-to-lobby timing; this overlay is purely a display and never
          drives that transition itself. */}
      {gameOverData && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 10500, display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '24px', background: 'rgba(2, 4, 10, 0.96)', backdropFilter: 'blur(10px)',
          animation: 'cinematicOverlayIn 900ms ease-in-out forwards'
        }}>
          <div style={{
            width: 'min(640px, 100%)', maxHeight: '86vh', overflowY: 'auto',
            background: 'linear-gradient(145deg, rgba(13, 14, 24, 0.98) 0%, rgba(6, 8, 6, 0.98) 100%)',
            border: '1px solid rgba(0,255,135,0.35)', borderRadius: '22px',
            boxShadow: '0 30px 100px rgba(0,255,135,0.15)', padding: '32px', boxSizing: 'border-box',
            textAlign: 'center', animation: 'verdictEnter 620ms cubic-bezier(0.16, 1, 0.3, 1) both'
          }}>
            <p style={{ margin: '0 0 8px 0', fontSize: '11px', letterSpacing: '3px', color: '#8a99ad' }}>{language === 'ru' ? 'ИГРА ЗАВЕРШЕНА' : language === 'uk' ? "ГРУ ЗАВЕРШЕНО" : language === 'es' ? 'PARTIDA FINALIZADA' : language === 'de' ? 'SPIEL BEENDET' : language === 'fr' ? 'PARTIE TERMINÉE' : 'MATCH CONCLUDED'}</p>
            <h2 style={{
              margin: '0 0 14px 0', fontSize: 'clamp(26px, 5vw, 42px)', fontWeight: 900,
              color: '#00ff87', textShadow: '0 0 30px rgba(0,255,135,0.5)', letterSpacing: '1px', textTransform: 'uppercase'
            }}>
              {gameOverData.winner === 'Innocent'
                ? (language === 'ru' ? 'ПОБЕДА КОМАНДЫ НЕВИННЫХ' : language === 'uk' ? "ПЕРЕМОГА КОМАНДИ НЕВИННИХ" : language === 'es' ? 'VICTORIA DEL EQUIPO INOCENTE' : language === 'de' ? 'SIEG DES UNSCHULDIGEN-TEAMS' : language === 'fr' ? "VICTOIRE DE L'ÉQUIPE INNOCENTE" : 'INNOCENT TEAM VICTORY')
                : gameOverData.winner === 'Joker'
                  ? (language === 'ru' ? 'ПОБЕДА ДЖОКЕРА' : language === 'uk' ? "ПЕРЕМОГА ДЖОКЕРА" : language === 'es' ? 'VICTORIA DEL COMODÍN' : language === 'de' ? 'SIEG DES JOKERS' : language === 'fr' ? 'VICTOIRE DU JOKER' : 'JOKER VICTORY')
                  : (language === 'ru' ? `ПОБЕДА КОМАНДЫ ${gameOverData.winner || 'НЕИЗВЕСТНО'}` : language === 'uk' ? `ПЕРЕМОГА КОМАНДИ ${gameOverData.winner || 'НЕВІДОМО'}` : language === 'es' ? `VICTORIA DEL EQUIPO ${gameOverData.winner || 'DESCONOCIDO'}` : language === 'de' ? `SIEG DES TEAMS ${gameOverData.winner || 'UNBEKANNT'}` : language === 'fr' ? `VICTOIRE DE L'ÉQUIPE ${gameOverData.winner || 'INCONNUE'}` : `${gameOverData.winner || 'UNKNOWN'} TEAM VICTORY`)}
            </h2>
            <p style={{ margin: '0 0 22px 0', color: '#c9d3e0', lineHeight: 1.6, fontSize: '14px' }}>
              {translateGameOverMessage(gameOverData, language)}
              {gameOverData.digitalCode && (
                <><br /><span style={{ color: '#76ffb4', letterSpacing: '3px', fontFamily: 'Georgia, serif' }}>{language === 'ru' ? 'КОД ОТМЕНЫ' : language === 'uk' ? "КОД СКАСУВАННЯ" : language === 'es' ? 'CÓDIGO DE ANULACIÓN' : language === 'de' ? 'AUFHEBUNGSCODE' : language === 'fr' ? 'CODE DE REMPLACEMENT' : 'OVERRIDE CODE'}: {gameOverData.digitalCode}</span></>
              )}
            </p>

            <div style={{ fontSize: '10px', letterSpacing: '2px', color: '#8a99ad', marginBottom: '10px' }}>{language === 'ru' ? 'ИТОГОВЫЕ РОЛИ' : language === 'uk' ? "ПІДСУМКОВІ РОЛІ" : language === 'es' ? 'ROLES FINALES' : language === 'de' ? 'FINALE ROLLEN' : language === 'fr' ? 'RÔLES FINAUX' : 'FINAL ROLES'}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '20px' }}>
              {(gameOverData.roster || []).map(entry => (
                <div key={entry.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '8px 12px', borderRadius: '8px',
                  border: '1px solid rgba(255,255,255,0.08)',
                  background: entry.isEliminated ? 'rgba(255,42,95,0.06)' : 'rgba(255,255,255,0.03)'
                }}>
                  <span style={{ color: entry.isEliminated ? '#ff8da6' : '#e2e8f0', fontSize: '13px' }}>
                    {entry.nickname}{entry.isEliminated ? (language === 'ru' ? ' (устранён)' : language === 'uk' ? " (усунений)" : language === 'es' ? ' (eliminado)' : language === 'de' ? ' (ausgeschaltet)' : language === 'fr' ? ' (éliminé)' : ' (eliminated)') : ''}
                  </span>
                  <span style={{ fontSize: '12px', fontWeight: 800, letterSpacing: '1px', color: ROLES[entry.role]?.color || '#8a99ad' }}>
                    {(language === 'ru' ? ROLES[entry.role]?.labelRu : language === 'uk' ? ROLES[entry.role]?.labelUk : language === 'es' ? ROLES[entry.role]?.labelEs : language === 'de' ? ROLES[entry.role]?.labelDe : ROLES[entry.role]?.label) || entry.role || (language === 'ru' ? 'НЕИЗВЕСТНО' : language === 'uk' ? "НЕВІДОМО" : language === 'es' ? 'DESCONOCIDO' : language === 'de' ? 'UNBEKANNT' : language === 'fr' ? 'INCONNU' : 'UNKNOWN')}
                  </span>
                </div>
              ))}
            </div>

            <p style={{ margin: 0, fontSize: '11px', letterSpacing: '1px', color: '#6272a4', animation: 'introCaretBlink 1.6s ease-in-out infinite' }}>
              {language === 'ru' ? 'ВОЗВРАЩЕНИЕ В ЛОББИ...' : language === 'uk' ? "ПОВЕРНЕННЯ ДО ЛОБІ..." : language === 'es' ? 'REGRESANDO AL LOBBY...' : language === 'de' ? 'RÜCKKEHR ZUR LOBBY...' : language === 'fr' ? 'RETOUR AU LOBBY...' : 'RETURNING TO LOBBY...'}
            </p>
          </div>
        </div>
      )}

      {/* Server-authoritative phase events drive this shared blackout layer. It
          intentionally sits above map, trial, dossier, and persistent chat. */}
      {cinematic && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 10000, display: 'flex', flexDirection: 'column', gap: '22px',
          alignItems: 'center', justifyContent: 'center',
          background: '#000', pointerEvents: cinematic.mode === 'reveal' ? 'none' : 'auto',
          opacity: cinematic.mode === 'reveal' ? 0 : 1,
          animation: cinematic.mode === 'reveal'
            ? 'cinematicOverlayOut 1500ms ease-in-out forwards'
            : cinematic.mode === 'announcement' ? 'none' : 'cinematicOverlayIn 1500ms ease-in-out forwards'
        }}>
          {cinematic.text && <div style={{
            maxWidth: 'min(900px, 88vw)', padding: '28px 34px', textAlign: 'center', borderRadius: '8px',
            border: `1px solid ${cinematic.accent === 'cyan' ? 'rgba(0,240,255,0.65)' : 'rgba(255,42,95,0.75)'}`,
            background: '#0a0a0f', color: cinematic.accent === 'cyan' ? '#00f0ff' : '#ff2a5f',
            boxShadow: cinematic.accent === 'cyan' ? '0 0 45px rgba(0,240,255,0.3)' : '0 0 55px rgba(255,42,95,0.38)',
            fontSize: 'clamp(22px, 4vw, 54px)', fontWeight: 900, lineHeight: 1.2,
            textTransform: 'uppercase', textShadow: '0 0 18px currentColor', animation: 'cinematicTextIn 650ms ease-out both'
          }}>
            {cinematic.text}
          </div>}

          {/* Case-file recap: everything the group has actually discovered so
              far (bodies someone stumbled onto/searched, evidence someone
              investigated — see buildFindingsSummary on the server). Only
              shown during the announcement window, right before voting opens. */}
          {cinematic.mode === 'announcement' && trialFindings && (
            <div style={{
              maxWidth: 'min(560px, 88vw)', maxHeight: '46vh', overflowY: 'auto', width: '100%',
              padding: '18px 22px', borderRadius: '8px', border: '1px solid rgba(0,240,255,0.3)',
              background: 'rgba(10,10,15,0.9)', animation: 'cinematicTextIn 650ms ease-out 150ms both'
            }}>
              <div style={{ fontSize: '11px', letterSpacing: '2px', color: '#6272a4', marginBottom: '10px', textAlign: 'center' }}>
                {language === 'ru' ? 'МАТЕРИАЛЫ ДЕЛА — ЧТО НАЙДЕНО НА ДАННЫЙ МОМЕНТ' : language === 'uk' ? "МАТЕРІАЛИ СПРАВИ — ЩО ЗНАЙДЕНО НА ДАНИЙ МОМЕНТ" : language === 'es' ? 'EXPEDIENTE DEL CASO — LO ENCONTRADO HASTA AHORA' : language === 'de' ? 'FALLAKTE — BISHER GEFUNDENES' : language === 'fr' ? "DOSSIER DE L'AFFAIRE — CE QUI A ÉTÉ TROUVÉ JUSQU'ICI" : "CASE FILE — WHAT'S BEEN FOUND SO FAR"}
              </div>
              {trialFindings.undiscoveredCount > 0 && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#ffcf6b',
                  marginBottom: (trialFindings.bodies?.length || 0) > 0 || (trialFindings.clues?.length || 0) > 0 ? '8px' : '0',
                  justifyContent: 'center', textAlign: 'center'
                }}>
                  <Icon name="skull" size={13} />
                  <span>
                    {trialFindings.undiscoveredCount === 1
                      ? (language === 'ru' ? 'Кто-то был убит, но тело ещё не найдено.' : language === 'uk' ? "Когось було вбито, але тіло ще не знайдено." : language === 'es' ? 'Alguien fue asesinado, pero el cuerpo aún no ha sido encontrado.' : language === 'de' ? 'Jemand wurde getötet, aber die Leiche wurde noch nicht gefunden.' : language === 'fr' ? "Quelqu'un a été tué, mais le corps n'a pas encore été trouvé." : 'Someone was killed, but the body hasn\u2019t been found yet.')
                      : (language === 'ru' ? `Убито агентов: ${trialFindings.undiscoveredCount}, но их тела ещё не найдены.` : language === 'uk' ? `Вбито агентів: ${trialFindings.undiscoveredCount}, але їхні тіла ще не знайдені.` : language === 'es' ? `Agentes asesinados: ${trialFindings.undiscoveredCount}, pero sus cuerpos aún no han sido encontrados.` : language === 'de' ? `Getötete Agenten: ${trialFindings.undiscoveredCount}, aber ihre Leichen wurden noch nicht gefunden.` : language === 'fr' ? `${trialFindings.undiscoveredCount} agents ont été tués, mais leurs corps n'ont pas encore été trouvés.` : `${trialFindings.undiscoveredCount} agents were killed, but their bodies haven't been found yet.`)}
                  </span>
                </div>
              )}
              {(trialFindings.bodies?.length || 0) === 0 && (trialFindings.clues?.length || 0) === 0 ? (
                trialFindings.undiscoveredCount > 0 ? null : (
                  <div style={{ fontSize: '13px', color: '#8a99ad', textAlign: 'center' }}>{language === 'ru' ? 'Пока ничего не найдено.' : language === 'uk' ? "Поки що нічого не знайдено." : language === 'es' ? 'Todavía no se ha encontrado nada.' : language === 'de' ? 'Bisher wurde noch nichts gefunden.' : language === 'fr' ? "Rien n'a encore été trouvé." : 'Nothing has been found yet.'}</div>
                )
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {(trialFindings.bodies || []).map((body, idx) => (
                    <div key={`body-${idx}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#ff8fa8' }}>
                      <Icon name="skull" size={13} />
                      <span>{language === 'ru' ? `Тело ${body.nickname} — найдено в ${translateRoomName(body.roomName, language)}` : language === 'uk' ? `Тіло ${body.nickname} — знайдено в ${translateRoomName(body.roomName, language)}` : language === 'es' ? `Cuerpo de ${body.nickname} — encontrado en ${translateRoomName(body.roomName, language)}` : language === 'de' ? `Leiche von ${body.nickname} — gefunden in ${translateRoomName(body.roomName, language)}` : language === 'fr' ? `Corps de ${body.nickname} — trouvé dans ${body.roomName}` : `${body.nickname}'s body — found in ${body.roomName}`}</span>
                    </div>
                  ))}
                  {(trialFindings.clues || []).map((clue) => (
                    <div key={`clue-${clue.id}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#a6ffcf' }}>
                      <Icon name="search" size={13} />
                      <span>{translateEvidenceName(clue.text, language)}{clue.roomName ? ` — ${translateRoomName(clue.roomName, language)}` : ''}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {phaseTransition > 0 && (
        <div key={phaseTransition} aria-hidden="true" style={{ position: 'fixed', inset: 0, zIndex: 9997, pointerEvents: 'none', background: 'rgba(1, 3, 9, 0.96)', animation: 'phaseCrossfade 440ms ease-in-out both', willChange: 'opacity' }} />
      )}

      {/* --- COUNTDOWN 5 -> 0 OVERLAY --- */}
      {countdown !== null && (
        <div style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(0,0,0,0.65)',
          backdropFilter: 'blur(4px)',
          zIndex: 9998
        }}>
          <div
            key={countdown}
            style={{
              fontSize: 'clamp(72px, 26vw, 160px)',
              fontWeight: 900,
              color: '#00f0ff',
              textShadow: '0 0 50px rgba(0,240,255,0.7)',
              fontFamily: 'Georgia, serif',
              animation: 'countdownPulse 1s ease-out'
            }}
          >
            {countdown}
          </div>
        </div>
      )}

      {/* --- FADE-TO-BLACK AFTER THE COUNTDOWN ---
           pointerEvents switches to 'auto' during the fade to fully block
           clicks on lobby buttons underneath the overlay. */}
      {isGameStarting && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: '#000',
          opacity: fadeOpacity,
          transition: 'opacity 3s ease-in-out',
          zIndex: 9999,
          pointerEvents: 'auto'
        }} />
      )}

      {/* --- DEVELOPER SUPPORT ICON (bottom-right, shown on menu screens) --- */}
      {isNicknameSet && currentScreen === 'main' && (
        <button
          onClick={() => setShowSupportPopup(true)}
          aria-label={language === 'ru' ? 'Поддержать разработчика' : language === 'uk' ? "Підтримати розробника" : language === 'es' ? 'Apoyar al desarrollador' : language === 'de' ? 'Den Entwickler unterstützen' : language === 'fr' ? 'Soutenir le développeur' : 'Support the developer'}
          style={{
            position: 'fixed',
            right: '20px',
            bottom: `${20 + bottomInset}px`,
            zIndex: 60,
            width: '58px',
            height: '58px',
            padding: 0,
            border: '2px solid rgba(255, 255, 255, 0.25)',
            borderRadius: '50%',
            cursor: 'pointer',
            background: 'rgba(18, 18, 28, 0.9)',
            boxShadow: '0 0 0 0 rgba(0, 240, 255, 0.55), 0 8px 24px rgba(0,0,0,0.5)',
            animation: 'supportIconPulse 2.2s ease-in-out infinite',
            transition: 'transform 0.2s ease'
          }}
          onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.08)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
        >
          <img
            src="https://files.catbox.moe/amibax.png"
            alt=""
            style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover', display: 'block' }}
          />
        </button>
      )}

      {/* --- DEVELOPER SUPPORT POPUP --- */}
      {showSupportPopup && (
        <div
          onClick={() => setShowSupportPopup(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 70,
            background: 'rgba(0, 0, 0, 0.6)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px'
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'rgba(18, 18, 28, 0.95)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '16px',
              padding: '28px 26px',
              maxWidth: '360px',
              width: '100%',
              textAlign: 'center',
              boxShadow: '0 20px 50px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255,255,255,0.08)'
            }}
          >
            <img
              src="https://files.catbox.moe/amibax.png"
              alt={language === 'ru' ? 'Разработчик' : language === 'uk' ? "Розробник" : language === 'es' ? 'Desarrollador' : language === 'de' ? 'Entwickler' : language === 'fr' ? 'Développeur' : 'Developer'}
              style={{ width: '64px', height: '64px', borderRadius: '50%', objectFit: 'cover', marginBottom: '14px' }}
            />
            <p style={{ color: '#e6e9ef', fontSize: '14px', lineHeight: 1.6, margin: '0 0 20px 0' }}>
              {language === 'ru'
                ? 'Я инди-разработчик этой игры. Если вам нравится в неё играть, любая поддержка будет много значить для меня!'
                : language === 'uk' ? "Я інді-розробник цієї гри. Якщо вам подобається в неї грати, будь-яка підтримка буде багато значити для мене!" : language === 'es' ? '¡Soy un desarrollador independiente de este juego. Si te gusta jugarlo, cualquier apoyo significaría mucho para mí!' : language === 'de' ? 'Ich bin ein Indie-Entwickler dieses Spiels. Wenn es dir Spaß macht, es zu spielen, würde mir jede Unterstützung sehr viel bedeuten!' : language === 'fr' ? "Je suis un développeur indépendant travaillant sur ce jeu. Si vous aimez y jouer, tout soutien compterait énormément pour moi !" : "I'm an indie developer working on this game. If you enjoy playing it, any support would mean a lot to me!"}
            </p>
            <a
              href="https://boosty.to/limxelstudio/donate"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-block',
                padding: '10px 22px',
                borderRadius: '10px',
                background: 'linear-gradient(135deg, #ff2a5f, #ff5f8f)',
                color: '#fff',
                fontWeight: 'bold',
                fontSize: '13px',
                letterSpacing: '1px',
                textDecoration: 'none',
                textTransform: 'uppercase',
                boxShadow: '0 8px 20px rgba(255, 42, 95, 0.35)'
              }}
            >
              {language === 'ru' ? 'Поддержать на Boosty' : language === 'uk' ? "Підтримати на Boosty" : language === 'es' ? 'Apoyar en Boosty' : language === 'de' ? 'Auf Boosty unterstützen' : language === 'fr' ? 'Soutenir sur Boosty' : 'Support on Boosty'}
            </a>
            <div
              onClick={() => setShowSupportPopup(false)}
              style={{
                marginTop: '16px',
                fontSize: '11px',
                color: '#8a99ad',
                cursor: 'pointer',
                letterSpacing: '1px',
                textTransform: 'uppercase'
              }}
            >
              {language === 'ru' ? 'Закрыть' : language === 'uk' ? "Закрити" : language === 'es' ? 'Cerrar' : language === 'de' ? 'Schließen' : language === 'fr' ? 'Fermer' : 'Close'}
            </div>
          </div>
        </div>
      )}

      {/* --- BUG REPORT / CONTACT SUPPORT POPUP --- */}
      {showContactSupportPopup && (
        <div
          onClick={() => setShowContactSupportPopup(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 70,
            background: 'rgba(0, 0, 0, 0.6)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px'
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'rgba(18, 18, 28, 0.95)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '16px',
              padding: '28px 26px',
              maxWidth: '360px',
              width: '100%',
              textAlign: 'center',
              boxShadow: '0 20px 50px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255,255,255,0.08)'
            }}
          >
            <div style={{
              width: '54px',
              height: '54px',
              borderRadius: '50%',
              background: 'rgba(0, 240, 255, 0.1)',
              border: '1px solid rgba(0, 240, 255, 0.35)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 14px'
            }}>
              <Icon name="mail" size={22} color="#00f0ff" />
            </div>
            <h3 style={{ color: '#00f0ff', fontSize: '15px', letterSpacing: '1.5px', margin: '0 0 10px 0' }}>
              {t('supportPopupTitle')}
            </h3>
            <p style={{ color: '#bdc7db', fontSize: '13px', lineHeight: 1.6, margin: '0 0 16px 0' }}>
              {t('supportPopupDesc')}
            </p>
            <div style={{
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '8px',
              padding: '10px 14px',
              color: '#e6e9ef',
              fontSize: '13px',
              fontWeight: 'bold',
              letterSpacing: '0.5px',
              wordBreak: 'break-all',
              marginBottom: '18px'
            }}>
              {SUPPORT_EMAIL}
            </div>
            <button
              onClick={copySupportEmail}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                padding: '10px 22px',
                borderRadius: '10px',
                background: supportEmailCopied ? 'rgba(0, 255, 135, 0.12)' : 'linear-gradient(135deg, #00c2ff, #00f0ff)',
                border: supportEmailCopied ? '1px solid #00ff87' : 'none',
                color: supportEmailCopied ? '#00ff87' : '#04121a',
                fontWeight: 'bold',
                fontSize: '13px',
                letterSpacing: '1px',
                textTransform: 'uppercase',
                cursor: 'pointer',
                boxShadow: supportEmailCopied ? 'none' : '0 8px 20px rgba(0, 240, 255, 0.3)'
              }}
            >
              <Icon name={supportEmailCopied ? 'check' : 'copy'} size={14} />
              {supportEmailCopied ? t('emailCopied') : t('copyEmail')}
            </button>
            <div
              onClick={() => setShowContactSupportPopup(false)}
              style={{
                marginTop: '16px',
                fontSize: '11px',
                color: '#8a99ad',
                cursor: 'pointer',
                letterSpacing: '1px',
                textTransform: 'uppercase'
              }}
            >
              {language === 'ru' ? 'Закрыть' : language === 'uk' ? 'Закрити' : language === 'es' ? 'Cerrar' : language === 'de' ? 'Schließen' : language === 'fr' ? 'Fermer' : 'Close'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;