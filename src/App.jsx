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
const DOPAMINE_CORNER_VIDEO = 'https://files.catbox.moe/jp8f3r.mp4';

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

// --- LANGUAGES: selectable in Settings. Only English and Russian are
// actually wired up to the UI text right now (see `language` state and
// UI_TEXT below) — the rest are placeholders for future localization,
// listed roughly by number of speakers worldwide.
const APP_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ru', label: 'Русский' },
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
    classifiedDossier: 'CLASSIFIED DOSSIER'
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
    classifiedDossier: 'СЕКРЕТНОЕ ДОСЬЕ'
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
    color: '#ff2a5f',
    sprite: 'https://i.postimg.cc/K8WMPW4s/15c3aab1-6af8-4f71-8190-91a3017ae631.jpg',
    description: 'Eliminate targets under cover of night. One strike per turn.',
    descriptionRu: 'Устраняйте цели под покровом ночи. Один удар за ход.'
  },
  Accomplice: {
    label: 'ACCOMPLICE',
    labelRu: 'СООБЩНИК',
    color: '#ff2a5f',
    sprite: 'https://i.postimg.cc/FH6Ly61T/1bff526b-381a-4464-8439-bcb173ddda17.jpg',
    description: 'Scramble the evidence feeds. You receive the Killer\'s reports.',
    descriptionRu: 'Искажайте потоки улик. Вы получаете отчёты Убийцы.'
  },
  Innocent: {
    label: 'INNOCENT',
    labelRu: 'НЕВИННЫЙ',
    color: '#00ff87',
    sprite: 'https://i.postimg.cc/sgLhYL1N/bb4a6ebf-afab-4e2a-bee8-df0067360ba6.jpg',
    description: 'Search the mansion for the override code. Find it, and escape quarantine.',
    descriptionRu: 'Ищите по особняку код отмены протокола. Найдите его — и выберитесь из карантина.'
  },
  Detective: {
    label: 'DETECTIVE',
    labelRu: 'ДЕТЕКТИВ',
    color: '#00f0ff',
    sprite: 'https://i.postimg.cc/vZKVrKDK/082786d9-31b4-474f-acba-562a20ec018a.jpg',
    description: 'Shadow a profile\'s network path. One trace per turn.',
    descriptionRu: 'Отслеживайте сетевой путь подозреваемого. Одна проверка за ход.'
  },
  Officer: {
    label: 'OFFICER',
    labelRu: 'ОФИЦЕР',
    color: '#00f0ff',
    sprite: 'https://i.postimg.cc/vZKVrKDk/dc83107d-3ed0-46d0-84ac-72ceb725ebf4.jpg',
    description: 'Shield an ally from harm. One protocol lock every 3 turns.',
    descriptionRu: 'Защищайте союзника от опасности. Один протокольный захват раз в 3 хода.'
  },
  Forensic: {
    label: 'FORENSIC',
    labelRu: 'КРИМИНАЛИСТ',
    color: '#00f0ff',
    sprite: 'https://i.postimg.cc/fRP9cPk1/d9a46ad6-0508-43b9-bd5a-28e1e378bf48.jpg',
    description: 'Authenticate telemetry validity. One analysis every 2 turns.',
    descriptionRu: 'Проверяйте подлинность телеметрии. Один анализ раз в 2 хода.'
  },
  Joker: {
    label: 'JOKER',
    labelRu: 'ДЖОКЕР',
    color: '#e040fb',
    sprite: 'https://i.postimg.cc/Cx2qG2dr/12d256b6-17de-4a39-b551-44760940de79.jpg',
    description: 'Wanted dead. You win if the council votes to execute you. Plant a piece of personal evidence in a searched room once every 2 turns.',
    descriptionRu: 'Разыскивается для устранения. Вы побеждаете, если совет проголосует за вашу казнь. Подбрасывайте личную улику в обысканной комнате раз в 2 хода.'
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

// Translates a room name for display only. `name` is whatever English string
// the server/MANSION_LAYOUT gave us; falls back to the original if there's
// no mapping (e.g. an unexpected/legacy value) or the UI isn't in Russian.
function translateRoomName(name, language) {
  if (language !== 'ru' || !name) return name;
  return ROOM_NAMES_RU[name] || name;
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

// Evidence item NAME for display — falls back to the raw server string for
// anything unrecognized or when the UI isn't Russian.
function translateEvidenceName(text, language) {
  if (language !== 'ru' || !text) return text;
  return EVIDENCE_RU[text]?.name || text;
}

// Evidence item DESCRIPTION for display — keyed off the item's (untranslated)
// `text`, since that's the stable id shared with EVIDENCE_RU above. Falls
// back to whatever description string the server actually sent.
function translateEvidenceDescription(text, description, language) {
  if (language !== 'ru') return description;
  return EVIDENCE_RU[text]?.description || description;
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

// Victim scene description for display — keyed by `character` (e.g. from
// the findings/body payload), falling back to whatever description string
// the server actually sent (covers the 'Mysterious...'-style generic
// fallback the server uses when `character` is missing).
function translateBodyDescription(character, description, language) {
  if (language !== 'ru') return description;
  return BODY_DESCRIPTIONS_RU[character] || description;
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
  if (language !== 'ru') return result.message;
  switch (result.reason) {
    case 'skipped':
      return 'ГОЛОСОВАНИЕ ПРОПУЩЕНО — АГЕНТ НЕ УСТРАНЁН';
    case 'executed':
      return `${result.targetName} устранён(а) по решению совета.`;
    default:
      return result.message;
  }
}

// GAME_OVER summary overlay's victory explanation line.
function translateGameOverMessage(data, language) {
  if (!data) return '';
  if (language !== 'ru') return data.message;
  const name = data.triggeredBy?.nickname;
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

// code_submission_result rejection reasons (trap debuff / undiscovered body /
// wrong code) — surfaced as a toast via pushToast.
function translateCodeSubmissionMessage(payload, language) {
  if (!payload) return '';
  if (language !== 'ru') return payload.message;
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
            {floorNum === 0 ? (language === 'ru' ? 'ПОДВАЛ' : 'BASEMENT') : (language === 'ru' ? `ЭТАЖ ${floorNum}` : `FLOOR ${floorNum}`)}
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
                  {language === 'ru' ? 'Заперто' : 'Locked'}
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
                  {language === 'ru' ? '✓ Проверено' : '✓ Clear'}
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
          {language === 'ru' ? 'ВЫБЕРИТЕ КОМНАТУ ДЛЯ ОБЫСКА — ОДНА ЗА ХОД' : 'SELECT A ROOM TO SEARCH — ONE PER TURN'}
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
            <p style={{ margin: '0 0 4px 0', fontSize: '11px', letterSpacing: '2px', color: '#e040fb' }}>{language === 'ru' ? 'ДЖОКЕР — ПОДБРОСИТЬ УЛИКУ' : 'JOKER — PLANT EVIDENCE'}</p>
            <h3 style={{ margin: 0, fontSize: '20px', color: '#f0c6ff', letterSpacing: '1px' }}>{language === 'ru' ? 'ВЫБЕРИТЕ КОМНАТУ' : 'CHOOSE A ROOM'}</h3>
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
            {language === 'ru' ? 'ОТМЕНА' : 'CANCEL'}
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
              {floorNum === 0 ? (language === 'ru' ? 'ПОДВАЛ' : 'BASEMENT') : (language === 'ru' ? `ЭТАЖ ${floorNum}` : `FLOOR ${floorNum}`)}
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
                  {isSubmittingThis ? (language === 'ru' ? 'ПОДБРАСЫВАЕМ…' : 'PLANTING…') : translateRoomName(room.name, language).toUpperCase()}
                </span>
              </div>
            );
          })}
        </div>

        <p style={{ margin: 0, fontSize: '11px', letterSpacing: '0.5px', color: '#6272a4', textAlign: 'center' }}>
          {language === 'ru' ? 'Выберите любую комнату на этом этаже, чтобы оставить там улику.' : 'Pick any room on this floor to leave a piece of evidence behind.'}
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
            <p style={{ margin: '0 0 4px 0', fontSize: '11px', letterSpacing: '2px', color: '#ff9100' }}>{language === 'ru' ? 'СООБЩНИК — УСТАНОВИТЬ ЛОВУШКУ' : 'ACCOMPLICE — SET A TRAP'}</p>
            <h3 style={{ margin: 0, fontSize: '20px', color: '#ffd8a8', letterSpacing: '1px' }}>{language === 'ru' ? 'ВЫБЕРИТЕ КОМНАТУ' : 'CHOOSE A ROOM'}</h3>
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
            {language === 'ru' ? 'ОТМЕНА' : 'CANCEL'}
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
              {floorNum === 0 ? (language === 'ru' ? 'ПОДВАЛ' : 'BASEMENT') : (language === 'ru' ? `ЭТАЖ ${floorNum}` : `FLOOR ${floorNum}`)}
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
                  {isSubmittingThis ? (language === 'ru' ? 'УСТАНАВЛИВАЕМ…' : 'SETTING…') : translateRoomName(room.name, language).toUpperCase()}
                </span>
              </div>
            );
          })}
        </div>

        <p style={{ margin: 0, fontSize: '11px', letterSpacing: '0.5px', color: '#6272a4', textAlign: 'center' }}>
          {language === 'ru' ? 'Выберите любую комнату на этом этаже, чтобы установить там ловушку.' : 'Pick any room on this floor to set a trap there.'}
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
            <p style={{ margin: '0 0 4px 0', fontSize: '11px', letterSpacing: '2px', color: '#ff9100' }}>{language === 'ru' ? 'СООБЩНИК — ИЗМЕНИТЬ УЛИКУ' : 'ACCOMPLICE — CHANGE EVIDENCE'}</p>
            <h3 style={{ margin: 0, fontSize: '20px', color: '#ffd28e', letterSpacing: '1px' }}>{language === 'ru' ? 'КОГО ПОДСТАВИТЬ?' : 'FRAME WHO?'}</h3>
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
            {language === 'ru' ? 'ОТМЕНА' : 'CANCEL'}
          </button>
        </div>

        <p style={{ margin: 0, fontSize: '12px', letterSpacing: '0.5px', color: '#bdc7db', lineHeight: 1.5 }}>
          {language === 'ru' ? 'Изменяется:' : 'Altering:'} <span style={{ color: '#f0c6ff' }}>{evidenceText || (language === 'ru' ? 'эта улика' : 'this evidence')}</span>. {language === 'ru' ? 'Выберите, на кого она будет указывать — никто не узнает, что это сделали вы.' : "Pick who it should implicate — nobody will be told you're the one who changed it."}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '340px', overflowY: 'auto' }}>
          {eligiblePlayers.length === 0 ? (
            <p style={{ margin: '8px 0', color: '#6272a4', fontSize: '12px', textAlign: 'center' }}>{language === 'ru' ? 'Сейчас некого подставить.' : 'No eligible players to frame right now.'}</p>
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
                <span style={{ fontSize: '11px', letterSpacing: '1px', color: '#8a99ad' }}>{isSubmittingThis ? (language === 'ru' ? 'ПОДСТАВЛЯЕМ…' : 'FRAMING…') : (language === 'ru' ? 'ВЫБРАТЬ' : 'SELECT')}</span>
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
          <p style={{ margin: '0 0 6px 0', fontSize: '11px', letterSpacing: '2px', color: '#ff2a5f' }}>{language === 'ru' ? 'ЦЕЛЬ УСТРАНЕНА' : 'TARGET ELIMINATED'}</p>
          <h3 style={{ margin: 0, fontSize: '24px', color: '#ff9caf', letterSpacing: '1px' }}>{(targetNickname || (language === 'ru' ? 'АГЕНТ' : 'AGENT')).toUpperCase()} {language === 'ru' ? 'ПОВЕРЖЕН' : 'IS DOWN'}</h3>
          <p style={{ margin: '10px 0 0 0', fontSize: '12px', lineHeight: 1.5, color: '#c9a3ab' }}>
            {language === 'ru' ? 'Что сделать с телом?' : 'What do you do with the body?'}
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <NeonButton variant="danger" style={{ margin: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }} disabled={resolving} onClick={() => onChoose('hide')}>
            <Icon name="hatch" size={15} /> {language === 'ru' ? 'СПРЯТАТЬ ТЕЛО' : 'HIDE BODY'}
          </NeonButton>
          <NeonButton variant="primary" style={{ margin: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }} disabled={resolving} onClick={() => onChoose('expose')}>
            <Icon name="eye" size={15} /> {language === 'ru' ? 'ОСТАВИТЬ НА ВИДУ' : 'LEAVE BODY EXPOSED'}
          </NeonButton>
        </div>

        <p style={{ margin: 0, fontSize: '10px', letterSpacing: '0.5px', color: '#6272a4', textAlign: 'center' }}>
          {language === 'ru'
            ? 'Спрятанное тело найдут только целенаправленным поиском, но это использует прыжок через вентиляцию в этот ход. Оставленное на виду тело увидит следующий, кто зайдёт в комнату, а вентиляция останется доступной позже.'
            : "A hidden body is only ever found by an explicit search, but costs you this turn's vent hop. Leaving it exposed keeps the vent free to use afterward."}
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
          <p style={{ margin: '0 0 6px 0', fontSize: '11px', letterSpacing: '2px', color: '#8be7ff' }}>{language === 'ru' ? 'КРИМИНАЛИСТИЧЕСКИЙ АНАЛИЗ — ' : 'FORENSIC ANALYSIS — '}{(evidenceText || (language === 'ru' ? 'УЛИКА' : 'EVIDENCE')).toUpperCase()}</p>
          <h3 style={{ margin: 0, fontSize: '24px', color: accent, letterSpacing: '1px' }}>
            {isAuthentic ? (language === 'ru' ? 'ПОДЛИННАЯ' : 'AUTHENTIC') : (language === 'ru' ? 'СФАБРИКОВАНА / ПОДБРОШЕНА' : 'FABRICATED / PLANTED')}
          </h3>
        </div>

        <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.55, color: '#bdc7db' }}>
          {isAuthentic
            ? (language === 'ru' ? 'Этот предмет действительно принадлежит убийце — он был оставлен на месте преступления, а не подстроен.' : 'This item genuinely belongs to the killer — it was left behind at the scene, not staged.')
            : (language === 'ru' ? 'Этот предмет не подлинный. Он был сфабрикован или подделан — подброшен, чтобы ввести в заблуждение того, кто его найдёт.' : 'This item is not authentic. It was fabricated or tampered with — planted to mislead whoever found it.')}
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
          <p style={{ margin: '0 0 6px 0', fontSize: '11px', letterSpacing: '2px', color: '#ff2a5f' }}>{language === 'ru' ? 'ЛОВУШКА СРАБОТАЛА' : 'TRAP TRIGGERED'}</p>
          <h3 style={{ margin: 0, fontSize: '22px', color: '#ff9caf', letterSpacing: '1px' }}>
            {(translateRoomName(roomName, language) || (language === 'ru' ? 'ЭТА КОМНАТА' : 'THIS ROOM')).toUpperCase()}
          </h3>
        </div>

        <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.55, color: '#bdc7db' }}>
          {language === 'ru'
            ? 'В этой комнате была спрятана ловушка. Весь ваш следующий раунд — и фазу действий, и суд — вы не сможете расследовать, искать тела или использовать способности.'
            : "There was a trap hidden in this room. For all of your next round — both the search phase and the trial — you won't be able to investigate, search for bodies, or use any ability."}
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
          {language === 'ru' ? 'ЗАКРЫТЬ' : 'CLOSE'}
        </button>
      </div>
    </div>
  );
}

function ForensicBodyExaminationModal({ clue, onClose, language }) {
  const getSentence = () => {
    if (!clue) return language === 'ru' ? 'Улика недоступна.' : 'No clue available.';
    if (clue.type === 'bloodType') {
      return (
        <>
          {language === 'ru'
            ? <>Следы крови на месте преступления не совпадают с кровью жертвы — обнаружен тип <strong style={{ color: '#8be7ff' }}>{clue.value}</strong>.</>
            : <>Blood traces at the scene don't match the victim's — type <strong style={{ color: '#8be7ff' }}>{clue.value}</strong> found.</>}
        </>
      );
    }
    if (clue.type === 'height') {
      if (clue.value === 'tall') {
        return language === 'ru'
          ? <>Угол раны указывает, что нападавший был <strong style={{ color: '#8be7ff' }}>выше</strong> жертвы.</>
          : <>Wound angle suggests the attacker was <strong style={{ color: '#8be7ff' }}>taller</strong> than the victim.</>;
      }
      if (clue.value === 'short') {
        return language === 'ru'
          ? <>Угол раны указывает, что нападавший был <strong style={{ color: '#8be7ff' }}>ниже</strong> жертвы.</>
          : <>Wound angle suggests the attacker was <strong style={{ color: '#8be7ff' }}>shorter</strong> than the victim.</>;
      }
      return language === 'ru'
        ? <>Угол раны не показывает заметной разницы — нападавший, вероятно, был <strong style={{ color: '#8be7ff' }}>среднего роста</strong>.</>
        : <>Wound angle shows no notable difference — the attacker was likely of <strong style={{ color: '#8be7ff' }}>average height</strong>.</>;
    }
    if (clue.value === 'heavy') {
      return language === 'ru'
        ? <>Характер повреждений указывает на <strong style={{ color: '#8be7ff' }}>значительную физическую силу</strong>.</>
        : <>The nature of the injuries suggests <strong style={{ color: '#8be7ff' }}>significant physical strength</strong>.</>;
    }
    if (clue.value === 'light') {
      return language === 'ru'
        ? <>Характер повреждений указывает на <strong style={{ color: '#8be7ff' }}>умеренное, более лёгкое телосложение</strong>.</>
        : <>The nature of the injuries suggests a <strong style={{ color: '#8be7ff' }}>moderate, lighter build</strong>.</>;
    }
    return language === 'ru'
      ? <>Характер повреждений не указывает на необычно сильного или лёгкого нападавшего — вероятно, <strong style={{ color: '#8be7ff' }}>среднее телосложение</strong>.</>
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
          <p style={{ margin: '0 0 6px 0', fontSize: '11px', letterSpacing: '2px', color: '#8be7ff' }}>{language === 'ru' ? 'СУДЕБНО-МЕДИЦИНСКИЙ ОСМОТР ТЕЛА' : 'FORENSIC BODY EXAMINATION'}</p>
          <h3 style={{ margin: 0, fontSize: '22px', color: '#8be7ff', letterSpacing: '1px' }}>{language === 'ru' ? 'ОТЧЁТ ОСМОТРА' : 'SCENE REPORT'}</h3>
        </div>
        <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.7, color: '#bdc7db' }}>{getSentence()}</p>
        <button
          onClick={onClose}
          style={{
            alignSelf: 'flex-end', padding: '9px 18px', borderRadius: '8px', border: '1px solid rgba(0,240,255,0.3)',
            background: 'rgba(0,240,255,0.08)', color: '#8be7ff', fontSize: '11px', fontWeight: 800, letterSpacing: '1px', cursor: 'pointer'
          }}
        >
          {language === 'ru' ? 'ЗАКРЫТЬ' : 'CLOSE'}
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
          <div style={{ fontSize: '10px', color: isEliminated ? '#ff8da6' : '#8a99ad', marginTop: '2px' }}>{isEliminated ? (language === 'ru' ? 'УСТРАНЁН(А) — НАБЛЮДЕНИЕ' : 'ELIMINATED — SPECTATING') : playerCharacter?.name || (language === 'ru' ? 'НЕИЗВЕСТНО' : 'UNKNOWN')}</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: '8px', marginTop: '9px' }}>
        <span style={{ padding: '7px 9px', borderRadius: '8px', border: `1px solid ${isEliminated ? 'rgba(255,42,95,0.45)' : isConfirmed ? 'rgba(0,255,135,0.45)' : 'rgba(255,255,255,0.12)'}`, background: isEliminated ? 'rgba(255,42,95,0.12)' : isConfirmed ? 'rgba(0,255,135,0.1)' : 'rgba(255,255,255,0.03)', color: isEliminated ? '#ff9caf' : isConfirmed ? '#76ffb4' : '#8a99ad', fontSize: '10px', fontWeight: 800, letterSpacing: '1px', transition: 'all 0.3s ease' }}>{isEliminated ? (language === 'ru' ? 'НАБЛЮДАТЕЛЬ' : 'SPECTATOR') : isConfirmed ? (language === 'ru' ? 'ГОЛОС ОТДАН / ГОТОВ' : 'VOTED / READY') : (language === 'ru' ? 'ОЖИДАНИЕ' : 'WAITING')}</span>
        <button onClick={onVote} disabled={!canVote} style={{ flex: 1, padding: '7px', borderRadius: '8px', border: isDraft ? '1px solid #00ff87' : '1px solid rgba(255,42,95,0.55)', background: isDraft ? 'rgba(0,255,135,0.16)' : 'rgba(255,42,95,0.12)', color: isDraft ? '#76ffb4' : '#ff9caf', fontWeight: 800, cursor: canVote ? 'pointer' : 'not-allowed', transition: 'all 0.25s ease-in-out' }}>{isDraft ? (language === 'ru' ? 'ВЫБРАНО' : 'SELECTED') : (language === 'ru' ? 'ВЫБРАТЬ' : 'SELECT')}</button>
        <button onClick={onCheck} style={{ padding: '7px', borderRadius: '8px', border: '1px solid rgba(0,240,255,0.4)', background: 'rgba(0,240,255,0.08)', color: '#8be7ff', fontWeight: 800, cursor: 'pointer', transition: 'all 0.25s ease-in-out' }}>{language === 'ru' ? 'ИНФО' : 'INFO'}</button>
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
            🔍 {language === 'ru' ? 'ПРОВЕРИТЬ ЛОКАЦИЮ' : 'CHECK LOCATION'}
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
            {detectiveAvailable ? (language === 'ru' ? 'ГОТОВО' : 'READY') : (language === 'ru' ? `ПЕРЕЗАРЯДКА: ${detectiveTurnsRemaining}` : `COOLDOWN: ${detectiveTurnsRemaining}`)}
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
            🔒 {isSelf ? (language === 'ru' ? 'ЗАПЕРЕТЬ СЕБЯ В КАМЕРЕ' : 'LOCK MYSELF IN CELL') : (language === 'ru' ? 'ЗАПЕРЕТЬ В КАМЕРЕ' : 'LOCK IN CELL')}
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
            {officerAvailable ? (language === 'ru' ? 'ГОТОВО' : 'READY') : (language === 'ru' ? `ПЕРЕЗАРЯДКА: ${officerTurnsRemaining}` : `COOLDOWN: ${officerTurnsRemaining}`)}
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
  const [forensicVerifyStatus, setForensicVerifyStatus] = useState(null); // { available, turnsRemaining }
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
    const activeIntroStory = languageRef.current === 'ru' ? INTRO_STORY_RU : INTRO_STORY;

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
    const activeIntroStory = languageRef.current === 'ru' ? INTRO_STORY_RU : INTRO_STORY;
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
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : "You're still recovering from the trap — no abilities this round."); return; }
    setForensicVerifyingId(evidenceId);
    playAbilityUseSound(0.75);
    socket.emit('verify_evidence', { code: gameRoomCodeRef.current, evidenceId });
  };

  const handleExamineBody = (bodyId) => {
    if (myRole !== 'Forensic' || !gameRoomCodeRef.current || !bodyId) return;
    if (forensicVerifyStatus && forensicVerifyStatus.available === false) return;
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : "You're still recovering from the trap — no abilities this round."); return; }
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
      const activeIntroStory = languageRef.current === 'ru' ? INTRO_STORY_RU : INTRO_STORY;
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
    function onInvestigateResult({ roomId, type, digit, position, totalDigits, foundBy, selfFound, evidence }) {
      console.log('CLIENT investigate_result:', { roomId, type, position, totalDigits, foundBy, selfFound, evidence });
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

    // Killer only: the kill just landed server-side (see handleKillPlayer) —
    // this opens the mandatory post-kill modal. Only the Killer's own socket
    // ever receives this event.
    function onKillOptions({ targetId, targetNickname, roomId, targetCharacter }) {
      console.log('CLIENT kill_options:', { targetId, targetNickname, roomId });
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
      // Killer-only: the server rolled the 50% chance and decided a personal
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
    function onForensicAbilityStatus({ available, turnsRemaining }) {
      setForensicVerifyStatus({ available: Boolean(available), turnsRemaining: turnsRemaining ?? 0 });
    }

    function onForensicVerifyStatus({ available, turnsRemaining }) {
      onForensicAbilityStatus({ available, turnsRemaining });
    }

    // Forensic Examiner only: the server's answer to a single 'verify_evidence'
    // request (see handleVerifyEvidence). A cooldown rejection updates the
    // status badge and shows a toast just like the Joker's planting cooldown;
    // any other failure (e.g. the clue vanished from the board in the
    // meantime) just silently clears the loading state with no result shown.
    function onVerifyEvidenceResult({ success, reason, turnsRemaining, evidenceId, text, isAuthentic }) {
      console.log('CLIENT verify_evidence_result:', { success, reason, turnsRemaining, evidenceId, text, isAuthentic });
      setForensicVerifyingId(null);
      if (success) {
        setForensicVerifyStatus({ available: false, turnsRemaining: turnsRemaining ?? 3 });
        setForensicVerifyResult({ evidenceId, text, isAuthentic });
      } else if (reason === 'cooldown') {
        setForensicVerifyStatus({ available: false, turnsRemaining: turnsRemaining ?? 0 });
        pushToast(languageRef.current === 'ru' ? `Проверка улики на перезарядке ещё ${turnsRemaining} ход(а/ов).` : `Evidence verification is on cooldown for ${turnsRemaining} more turn(s).`);
      }
    }

    function onExamineBodyResult({ success, reason, turnsRemaining, clue, bodyId, report }) {
      console.log('CLIENT examine_body_result:', { success, reason, turnsRemaining, clue, bodyId, report });
      if (success) {
        setForensicVerifyStatus({ available: false, turnsRemaining: turnsRemaining ?? 0 });
        setForensicSavedReport(report || null);
        setForensicReportUnlocked(true);
        setForensicBodyExamineResult({ bodyId, clue });
      } else if (reason === 'cooldown') {
        setForensicVerifyStatus({ available: false, turnsRemaining: turnsRemaining ?? 0 });
        pushToast(languageRef.current === 'ru' ? `Осмотр тела на перезарядке ещё ${turnsRemaining} ход(а/ов).` : `Body examination is on cooldown for ${turnsRemaining} more turn(s).`);
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
      alert(language === 'ru' ? 'Никнейм должен содержать не менее 2 символов.' : 'Nickname must be at least 2 characters long.');
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
      setErrorMessage(language === 'ru' ? 'Код должен состоять ровно из 8 символов.' : 'Code must be exactly 8 characters.');
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
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде действия недоступны.' : "You're still recovering from the trap — no actions this round."); return; }
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
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде действия недоступны.' : "You're still recovering from the trap — no actions this round."); return; }
    setRoomActionTaken(true);
    playAbilityUseSound(0.75);
    socket.emit('search_body', { code: gameRoomCodeRef.current, roomId: revealedRoom.roomId });
  };

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
    if (!investigateUsedThisTurn) { pushToast(language === 'ru' ? 'Сначала обыщите эту комнату.' : 'Investigate this room first.'); return; }
    if (markRoomStatus && markRoomStatus.available === false) return;
    if (clearedRoomIds[revealedRoom.roomId]) return;
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : "You're still recovering from the trap — no abilities this round."); return; }
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
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : "You're still recovering from the trap — no abilities this round."); return; }
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
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : "You're still recovering from the trap — no abilities this round."); return; }
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
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : "You're still recovering from the trap — no abilities this round."); return; }
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
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : "You're still recovering from the trap — no abilities this round."); return; }
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
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : "You're still recovering from the trap — no abilities this round."); return; }
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
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : "You're still recovering from the trap — no abilities this round."); return; }
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
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : "You're still recovering from the trap — no abilities this round."); return; }
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
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : "You're still recovering from the trap — no abilities this round."); return; }
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
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — терминал не примет ввод в этом раунде.' : "You're still recovering from the trap — the terminal won't accept input this round."); return; }
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
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : "You're still recovering from the trap — no abilities this round."); return; }
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
    if (trapDebuffActive) { pushToast(language === 'ru' ? 'Вы всё ещё приходите в себя после ловушки — в этом раунде способности недоступны.' : "You're still recovering from the trap — no abilities this round."); return; }
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
                            {language === 'ru' ? ROLES[name].labelRu : ROLES[name].label}{count > 1 ? ` ×${count}` : ''}
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
              <p style={{ fontWeight: 'bold', color: '#ffeb3b', margin: '0 0 6px 0', letterSpacing: '1px' }}>1. ХОДЫ И ВРЕМЯ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Агенты действуют <strong>строго по очереди</strong>. У каждого есть до <strong>30 секунд</strong>, чтобы выбрать сектор для обыска — как только они входят в комнату и видят, кто там, их ход вскоре завершается.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff9100', margin: '0 0 6px 0', letterSpacing: '1px' }}>2. ДВЕ ФАЗЫ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                <strong>Фаза действий:</strong> скрытные манёвры и тактические действия.<br />
                <strong>Фаза суда:</strong> сбор, сопоставление улик и голосование за устранение подозреваемого.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff9100', margin: '0 0 6px 0', letterSpacing: '1px' }}>3. ВЕНТИЛЯЦИОННЫЕ ХОДЫ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 10px 0' }}>
                Только <strong>Убийца</strong> имеет доступ к сети вентиляционных ходов, соединяющих определённые комнаты особняка попарно. Использование хода мгновенно перемещает его в связанную комнату в рамках того же хода — быстрый и бесшумный способ попасть в комнату или покинуть её, не идя по коридорам. Разрешён только <strong>один прыжок через вентиляцию за ход</strong>.
              </p>
              <p style={{ color: '#ff9100', margin: '0 0 6px 0', fontSize: '12px', letterSpacing: '0.5px', textTransform: 'uppercase' }}>Известные соединения вентиляции:</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 18px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#fff' }}>Главный зал</strong> (1-й этаж) ↔ <strong style={{ color: '#fff' }}>Спальня хозяев</strong> (2-й этаж)</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#fff' }}>Кухня</strong> ↔ <strong style={{ color: '#fff' }}>Оружейная</strong> (оба на 1-м этаже)</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#fff' }}>Винный погреб</strong> (1-й этаж) ↔ <strong style={{ color: '#fff' }}>Чердак</strong> (2-й этаж)</li>
              </ul>


              <p style={{ fontWeight: 'bold', color: '#00ff87', margin: '0 0 6px 0', letterSpacing: '1px' }}>4. ДАННЫЕ И УЛИКИ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Оперативники находят подлинные следы. <strong>Сообщники подбрасывают сфабрикованные данные</strong> в журналы.
              </p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                На каждом обнаруженном теле есть ровно один след телосложения или группы крови убийцы, зафиксированный в момент смерти — чем дольше тело остаётся неосмотренным, тем менее надёжным становится этот след. Чтобы собрать полный профиль, нужно осмотреть больше одного тела. Также есть небольшой шанс, что Убийца случайно обронит личную вещь своего персонажа в случайной комнате при убийстве — дополнительная улика, которую никто не подбрасывал специально.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 6px 0', letterSpacing: '1px' }}>5. СПРЯТАТЬ ИЛИ ОСТАВИТЬ ТЕЛО НА ВИДУ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Сразу после убийства <strong>Убийца</strong> должен выбрать: <strong>Спрятать</strong> тело — оно останется скрытым, пока кто-то намеренно не начнёт его искать, но это использует прыжок через вентиляцию в этот ход, так что вентилировать в этот ход нельзя — или <strong>Оставить на виду</strong>, чтобы его увидел следующий, кто зайдёт в комнату, при этом вентиляция остаётся доступной для использования позже.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff9100', margin: '0 0 6px 0', letterSpacing: '1px' }}>6. ЛОВУШКИ</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                <strong>Сообщник</strong> может установить в комнате скрытую ловушку (<strong style={{ color: '#fff' }}>1 раз в 4 раунда</strong>). Первый агент, зашедший в эту комнату — обычным шагом или через вентиляцию — активирует её: ловушка срабатывает мгновенно, и этот агент лишается всех действий и способностей на весь следующий раунд, включая фазу действий и суд.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 8px 0', letterSpacing: '1px' }}>7. АКТИВНЫЕ РОЛИ</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 18px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#ff2a5f' }}>Убийца:</strong> устраняет цели (<strong style={{ color: '#fff' }}>1 за ход</strong>), затем решает, спрятать тело или оставить на виду.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#ff9100' }}>Сообщник:</strong> искажает данные, сразу получает отчёты об убийствах и может установить ловушку в комнате (<strong style={{ color: '#fff' }}>1 раз в 4 раунда</strong>).</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#00f0ff' }}>Детектив:</strong> проверяет последнее известное местоположение подозреваемого во время суда (<strong style={{ color: '#fff' }}>1 раз в 2 раунда</strong>).</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#2979ff' }}>Офицер:</strong> запирает подозреваемого в камере (1-й этаж, нижний правый угол особняка) на следующий раунд, изолируя его от всех действий в комнатах (<strong style={{ color: '#fff' }}>1 раз в 3 раунда</strong>).</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#bdef13' }}>Криминалист:</strong> проверяет подлинность улики ИЛИ осматривает обнаруженное тело на предмет следа телосложения/группы крови убийцы — оба действия используют <strong style={{ color: '#fff' }}>общую перезарядку</strong>, доступную <strong style={{ color: '#fff' }}>раз в два раунда</strong>.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#e040fb' }}>Джокер:</strong> побеждает, если раскрыт и казнён советом. Может подбросить личную улику в обыскиваемой комнате раз в 2 своих хода.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#00ff87' }}>Невинный:</strong> без особых способностей. Ищет по особняку код отмены протокола, чтобы отменить карантин.</li>
              </ul>

              <p style={{ fontWeight: 'bold', color: '#9e9e9e', margin: '0 0 6px 0', letterSpacing: '1px' }}>8. ПРОТОКОЛ ПРИЗРАКА (ПОГИБШИЕ)</p>
              <p style={{ color: '#8a99ad', margin: '0 0 5px 0' }}>
                Терминальная передача прервана, но доступ открывает <strong style={{ color: '#00ff87' }}>неограниченный спутниковый обзор карты</strong>. Наблюдайте за происходящим.
              </p>
              </>
              ) : (
              <>
              <p style={{ fontWeight: 'bold', color: '#ffeb3b', margin: '0 0 6px 0', letterSpacing: '1px' }}>1. TURNS & TIMING</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Agents operate <strong>strictly in sequence</strong>. Each asset has up to <strong>30 seconds</strong> to pick a sector to search — the moment they move in and see who's there, their turn wraps up shortly after.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff9100', margin: '0 0 6px 0', letterSpacing: '1px' }}>2. TWO PHASE PARADIGM</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                <strong>Action Phase:</strong> Ghost maneuvers and tactical execution.<br />
                <strong>Trial Phase:</strong> Assembly, evidence triangulation, and asset termination votes.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff9100', margin: '0 0 6px 0', letterSpacing: '1px' }}>3. VENTILATION SHORTCUTS</p>
              <p style={{ color: '#8a99ad', margin: '0 0 10px 0' }}>
                The <strong>Killer</strong> alone can access a network of vent shortcuts linking specific mansion rooms in pairs. Using one instantly relocates them to the linked room as part of the same turn — a fast, silent way to reach or leave a scene without walking the halls. Only <strong>one vent hop is allowed per turn</strong>.
              </p>
              <p style={{ color: '#ff9100', margin: '0 0 6px 0', fontSize: '12px', letterSpacing: '0.5px', textTransform: 'uppercase' }}>Known vent connections:</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 18px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#fff' }}>Grand Hall</strong> (1st floor) ↔ <strong style={{ color: '#fff' }}>Master Bedroom</strong> (2nd floor)</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#fff' }}>Kitchen</strong> ↔ <strong style={{ color: '#fff' }}>Armory</strong> (both 1st floor)</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#fff' }}>Wine Cellar</strong> (1st floor) ↔ <strong style={{ color: '#fff' }}>Attic</strong> (2nd floor)</li>
              </ul>


              <p style={{ fontWeight: 'bold', color: '#00ff87', margin: '0 0 6px 0', letterSpacing: '1px' }}>4. DATA & INTEL</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Operatives recover genuine footprints. <strong>Accomplices feed fabricated data streams</strong> into the logs.
              </p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Every discovered body carries exactly one trace of its killer's build or blood type, fixed the moment they died — the longer a body goes unexamined, the less reliable that trace becomes. Piecing together a full profile takes more than one body. There's also a flat chance the Killer accidentally drops one of their own character's personal items in a random room on any kill — an extra clue nobody planted on purpose.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 6px 0', letterSpacing: '1px' }}>5. HIDE OR EXPOSE THE BODY</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                Right after a kill, the <strong>Killer</strong> must choose: <strong>Hide</strong> the body — it stays concealed until someone deliberately searches for it, but this uses up the turn's vent hop, so no venting that turn — or <strong>Expose</strong> it, leaving it in plain sight for whoever walks in next, while still keeping the vent free to use afterward.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff9100', margin: '0 0 6px 0', letterSpacing: '1px' }}>6. TRAPS</p>
              <p style={{ color: '#8a99ad', margin: '0 0 18px 0' }}>
                The <strong>Accomplice</strong> can rig a room with a hidden trap (<strong style={{ color: '#fff' }}>1 per 4 rounds</strong>). The first agent who walks into that room — whether via a normal move or a vent hop — sets it off: the trap is consumed instantly and that agent is locked out of every action and ability for their entire next round, action phase and Trial alike.
              </p>

              <p style={{ fontWeight: 'bold', color: '#ff2a5f', margin: '0 0 8px 0', letterSpacing: '1px' }}>7. ACTIVE ROLES IN THE FIELD</p>
              <ul style={{ color: '#8a99ad', paddingLeft: '15px', margin: '0 0 18px 0', listStyleType: 'square' }}>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#ff2a5f' }}>Killer:</strong> Neutralizes targets (<strong style={{ color: '#fff' }}>1/turn</strong>), then chooses to hide or expose the body.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#ff9100' }}>Accomplice:</strong> Scrambles feeds, receives immediate kill reports, and can plant a trap in a room (<strong style={{ color: '#fff' }}>1 per 4 rounds</strong>).</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#00f0ff' }}>Detective:</strong> Checks a suspect's last known location during the Trial (<strong style={{ color: '#fff' }}>1 per 2 rounds</strong>).</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#2979ff' }}>Officer:</strong> Locks a suspect in the Holding Cell (1st floor, bottom-right corner of the mansion) for the following round, isolating them from all room actions (<strong style={{ color: '#fff' }}>1 per 3 rounds</strong>).</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#bdef13' }}>Forensic:</strong> Verifies a piece of evidence's authenticity, OR examines a discovered body for a trace of the killer's build/blood type — both draw from the <strong style={{ color: '#fff' }}>same shared cooldown</strong>, available <strong style={{ color: '#fff' }}>once every other round</strong>.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#e040fb' }}>Joker:</strong> Wins if compromised and executed by the council. Can plant a piece of personal evidence in a searched room once every 2 of their turns.</li>
                <li style={{ marginBottom: '6px' }}><strong style={{ color: '#00ff87' }}>Innocent:</strong> No special power. Search the mansion for the override code to cancel the protocol and escape the quarantine.</li>
              </ul>

              <p style={{ fontWeight: 'bold', color: '#9e9e9e', margin: '0 0 6px 0', letterSpacing: '1px' }}>8. SPECTER PROTOCOL (DECEASED)</p>
              <p style={{ color: '#8a99ad', margin: '0 0 5px 0' }}>
                Terminal transmission cut off, but overrides grant <strong style={{ color: '#00ff87' }}>Unrestricted Satellite Map Feed</strong>. Watch everything unfold.
              </p>
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
                  aria-label={language === 'ru' ? 'Развернуть дофаминовый уголок' : 'Expand Dopamine Corner'}
                  style={{
                    position: 'fixed',
                    top: '16px',
                    right: '16px',
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
                  ▶ {language === 'ru' ? 'ДОФАМИНОВЫЙ УГОЛОК' : 'DOPAMINE CORNER'}
                </div>
                <video
                  ref={dopamineCornerVideoRef}
                  src={DOPAMINE_CORNER_VIDEO}
                  preload="auto"
                  autoPlay
                  loop
                  muted
                  playsInline
                  onClick={() => setDopamineCornerMinimized(true)}
                  aria-label={language === 'ru' ? 'Свернуть дофаминовый уголок' : 'Minimize Dopamine Corner'}
                  style={{
                    position: 'fixed',
                    top: '16px',
                    right: '16px',
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
              {language === 'ru' ? 'Установка защищённого канала...' : 'Establishing secure channel...'}
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
                      {skipVotes.count}/{skipVotes.total} {language === 'ru' ? 'ПРОГОЛОСОВАЛИ ЗА ПРОПУСК' : 'VOTED TO SKIP'}
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
                  {language === 'ru' ? 'Расшифровка личности...' : 'Decrypting identity...'}
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
                        alt={language === 'ru' ? activeRoleData.labelRu : activeRoleData.label}
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
                          {language === 'ru' ? activeRoleData.labelRu : activeRoleData.label}
                        </h2>
                        <p style={{
                          maxWidth: '380px',
                          margin: '0 auto',
                          fontSize: '13px',
                          lineHeight: '1.6',
                          color: '#bdc7db',
                          letterSpacing: '0.5px'
                        }}>
                          {language === 'ru' ? activeRoleData.descriptionRu : activeRoleData.description}
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
                    {language === 'ru' ? 'КОД ОТМЕНЫ' : 'OVERRIDE CODE'}
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
                  : `ROUND ${gameData.round} ${displayPhase === 'trial' ? '— TRIAL' : '— ACTION PHASE'}`}
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
                    {language === 'ru' ? 'ЗАПЕРТЫ В КАМЕРЕ' : 'LOCKED IN THE HOLDING CELL'}
                  </h2>
                  <p style={{ margin: 0, maxWidth: '420px', fontSize: '12px', lineHeight: 1.6, color: '#c9a5a2', letterSpacing: '0.3px' }}>
                    {language === 'ru'
                      ? 'Офицер запер вас здесь на весь этот раунд. Вы не можете двигаться, обыскивать комнаты или действовать — дождитесь начала следующего раунда.'
                      : 'The Officer has confined you here for the entirety of this round. You cannot move, search, or act — sit tight until the next round begins.'}
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
                    {language === 'ru' ? 'ДЕЙСТВИЯ В ЭТОМ РАУНДЕ НЕДОСТУПНЫ' : 'NO ACTIONS AVAILABLE THIS ROUND'}
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
                      ? (language === 'ru' ? 'ВАШ ХОД' : 'YOUR TURN')
                      // Deliberately not revealing which player is acting — only the
                      // player themself should know whose turn it is.
                      : (language === 'ru' ? 'АГЕНТ ДЕЙСТВУЕТ' : 'AN AGENT IS ACTING')}
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
                  <div aria-label={language === 'ru' ? 'Оставшееся время хода' : 'Turn time remaining'} style={{ width: 'min(340px, 80vw)', height: '5px', margin: '-8px auto 20px', overflow: 'hidden', borderRadius: '999px', background: 'rgba(255,255,255,0.1)' }}>
                    <div style={{ height: '100%', background: turnTimeLeft <= 5 ? '#ff2a5f' : '#00f0ff', boxShadow: `0 0 12px ${turnTimeLeft <= 5 ? '#ff2a5f' : '#00f0ff'}`, transformOrigin: 'left center', transform: `scaleX(${Math.max(0, Math.min(1, turnTimeLeft / TURN_DURATION_SECONDS))})`, transition: 'transform 1s linear, background-color 250ms ease', willChange: 'transform' }} />
                  </div>

                  {/* Mansion map with fog of war — visible only to whoever's turn it is.
                      Selecting a room opens a full-screen peek view so the player can
                      inspect it before ending the turn manually. */}
                  {canObserveMap && (
                    <div style={{ position: 'relative' }}>
                      {(isEliminated || isObserver) && <div style={{ margin: '0 0 12px', padding: '10px 12px', borderRadius: '10px', border: '1px solid rgba(255,42,95,0.45)', background: 'rgba(255,42,95,0.1)', color: '#ff9caf', fontSize: '11px', fontWeight: 800, letterSpacing: '1px', transition: 'all 0.3s ease' }}>{language === 'ru' ? 'НАБЛЮДЕНИЕ — СВОБОДНАЯ НАВИГАЦИЯ ПО КОМНАТАМ. АКТИВНЫЕ ИГРОКИ И ДЕЙСТВИЯ ЗАБЛОКИРОВАНЫ.' : 'SPECTATING — FREE ROOM NAVIGATION. ACTIVE PLAYERS AND ACTIONS ARE LOCKED.'}</div>}
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
                                  : `PLANT EVIDENCE (${jokerEvidenceStatus.turnsRemaining} TURN${jokerEvidenceStatus.turnsRemaining === 1 ? '' : 'S'} LEFT)`)
                              : <><Icon name="search" size={14} style={{ marginRight: 7 }} />{language === 'ru' ? 'ПОДБРОСИТЬ УЛИКУ' : 'PLANT EVIDENCE'}</>}
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
                                  : `SET A TRAP (${accompliceTrapStatus.roundsRemaining} ROUND${accompliceTrapStatus.roundsRemaining === 1 ? '' : 'S'} LEFT)`)
                              : <><Icon name="search" size={14} style={{ marginRight: 7 }} />{language === 'ru' ? 'УСТАНОВИТЬ ЛОВУШКУ' : 'SET A TRAP'}</>}
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
                                    {language === 'ru' ? 'ПРОСМОТР' : 'PEEKING INTO'}
                                  </p>
                                  <h3 style={{ margin: 0, fontSize: '26px', color: roomAccent, letterSpacing: '1px', textShadow: `0 0 18px ${roomAccent}55` }}>{translateRoomName(revealedRoom.roomName, language).toUpperCase()}</h3>
                                </div>
                              </div>
                              <div style={{ fontSize: '11px', letterSpacing: '1px', color: '#6272a4', textAlign: 'right' }}>
                                {(isEliminated || isObserver)
                                  ? (language === 'ru' ? 'РЕЖИМ НАБЛЮДЕНИЯ — ПРИСУТСТВУЮЩИЕ' : 'SPECTATOR VIEW — LIVE OCCUPANTS')
                                  : (language === 'ru' ? `ТАЙМЕР ХОДА: ${turnTimeLeft}с` : `TURN TIMER: ${turnTimeLeft}s`)}
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
                                    {language === 'ru' ? 'ЗДЕСЬ БОЛЬШЕ НИКОГО НЕТ' : 'NO OTHER AGENTS HERE'}
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
                                      title={canKillThis ? (language === 'ru' ? `Устранить ${occupant.nickname}` : `Eliminate ${occupant.nickname}`) : undefined}
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
                                      {language === 'ru' ? 'СООБЩНИК — НАЖМИТЕ НА УЛИКУ, ЧТОБЫ ПОДСТАВИТЬ' : 'ACCOMPLICE — TAP EVIDENCE TO REFRAME'}
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
                                      title={canChangeThis ? (language === 'ru' ? 'Изменить эту улику' : 'Change this evidence') : undefined}
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
                                      {canChangeThis && <span style={{ fontSize: '10px', letterSpacing: '1px', color: '#ffb974' }}>{language === 'ru' ? 'ИЗМЕНИТЬ' : 'CHANGE'}</span>}
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
                                <NeonButton variant="secondary" style={{ maxWidth: '260px', width: '100%', flexShrink: 0, marginBottom: 0 }} onClick={() => setRoomChosen(false)}>{language === 'ru' ? 'ВЕРНУТЬСЯ К КАРТЕ ОСОБНЯКА' : 'RETURN TO MANSION MAP'}</NeonButton>
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
                                    <Icon name="search" size={14} /> {language === 'ru' ? 'ИСКАТЬ ТЕЛО' : 'SEARCH FOR BODY'}
                                  </NeonButton>
                                  <NeonButton
                                    variant="primary"
                                    style={{ maxWidth: '260px', width: isMobile ? '220px' : '100%', flexShrink: 0, marginBottom: isMobile ? 0 : 14, scrollSnapAlign: 'start', opacity: roomActionTaken ? 0.5 : 1 }}
                                    disabled={roomActionTaken}
                                    onClick={handleInvestigateRoom}
                                  >
                                    {language === 'ru' ? 'ОБЫСКАТЬ КОМНАТУ' : 'INVESTIGATE ROOM'}
                                  </NeonButton>
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
                                        title={needsInvestigateFirst && !alreadyCleared ? (language === 'ru' ? 'Сначала обыщите эту комнату' : 'Investigate this room first') : undefined}
                                      >
                                        {alreadyCleared
                                          ? <><Icon name="check" size={14} /> {language === 'ru' ? 'УЖЕ ПРОВЕРЕНО' : 'ALREADY CLEAR'}</>
                                          : onCooldown
                                            ? (language === 'ru'
                                                ? `ПРОВЕРИТЬ КОМНАТУ (ОСТАЛОСЬ ${markRoomStatus.turnsRemaining} РАУНД${markRoomStatus.turnsRemaining === 1 ? '' : (markRoomStatus.turnsRemaining >= 2 && markRoomStatus.turnsRemaining <= 4 ? 'А' : 'ОВ')})`
                                                : `CHECK ROOM (${markRoomStatus.turnsRemaining} ROUND${markRoomStatus.turnsRemaining === 1 ? '' : 'S'} LEFT)`)
                                            : needsInvestigateFirst
                                              ? (language === 'ru' ? 'СНАЧАЛА ОБЫЩИТЕ' : 'INVESTIGATE FIRST')
                                              : <><Icon name="check" size={14} /> {language === 'ru' ? 'ПРОВЕРИТЬ КОМНАТУ' : 'CHECK ROOM'}</>}
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
                                      {ventUsedThisTurn ? (language === 'ru' ? 'ВЕНТИЛЯЦИЯ ИСПОЛЬЗОВАНА' : 'VENT USED') : <><Icon name="vent" size={14} /> {language === 'ru' ? 'ИСПОЛЬЗОВАТЬ ВЕНТИЛЯЦИЮ' : 'USE VENT'}</>}
                                    </NeonButton>
                                  )}
                                  <NeonButton variant="success" style={{ maxWidth: '260px', width: isMobile ? '220px' : '100%', flexShrink: 0, marginBottom: isMobile ? 0 : 14, scrollSnapAlign: 'start' }} onClick={handleEndTurn}>{language === 'ru' ? 'ЗАКОНЧИТЬ ХОД' : 'END TURN'}</NeonButton>
                                </>
                              )}
                            </div>
                            {isMobile && !(isEliminated || isObserver) && (
                              <p style={{ margin: '-4px 0 0 0', fontSize: '10px', color: '#5a6478', letterSpacing: '1px', textAlign: 'center' }}>
                                {language === 'ru' ? '← ПРОЛИСТНИТЕ, ЧТОБЫ УВИДЕТЬ ВСЕ ДЕЙСТВИЯ →' : '← SWIPE TO SEE ALL ACTIONS →'}
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
                          <p style={{ margin: '0 0 4px 0', fontSize: '11px', letterSpacing: '2px', color: '#8a99ad' }}>{language === 'ru' ? 'ЗАСЕДАНИЕ СОВЕТА' : 'COUNCIL SESSION'}</p>
                          <h3 style={{ margin: 0, fontSize: isMobile ? '19px' : '24px', color: '#00f0ff', letterSpacing: '1px' }}>{language === 'ru' ? 'ГОЛОСОВАНИЕ О КАЗНИ' : 'EXECUTION VOTE'}</h3>
                        </div>
                        <div style={{ textAlign: isMobile ? 'left' : 'right', width: isMobile ? '100%' : 'auto' }}>
                          <div style={{ fontSize: '11px', letterSpacing: '1px', color: '#8a99ad' }}>{language === 'ru' ? 'ОСТАЛОСЬ ВРЕМЕНИ' : 'TIME LEFT'}</div>
                          <div style={{ fontSize: '32px', fontWeight: 900, color: trialTimeLeft && trialTimeLeft <= 10 ? '#ff2a5f' : '#00f0ff' }}>
                            {trialTimeLeft ?? '--'}s
                          </div>
                          <div aria-label={language === 'ru' ? 'Оставшееся время суда' : 'Trial time remaining'} style={{ width: isMobile ? '100%' : '112px', height: '4px', margin: isMobile ? '5px 0 8px 0' : '5px 0 4px auto', overflow: 'hidden', borderRadius: '999px', background: 'rgba(255,255,255,0.1)' }}><div style={{ height: '100%', background: trialTimeLeft && trialTimeLeft <= 10 ? '#ff2a5f' : '#00f0ff', transformOrigin: 'right center', transform: `scaleX(${trialTimeLeft === null ? 1 : Math.max(0, Math.min(1, trialTimeLeft / TRIAL_DURATION_SECONDS))})`, transition: 'transform 1s linear, background-color 250ms ease', willChange: 'transform' }} /></div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', justifyContent: isMobile ? 'flex-start' : 'flex-end' }}>
                          <button onClick={() => selectTrialVote(null)} disabled={isEliminated || isObserver || trialData?.status !== 'voting' || trialData?.confirmedVoterIds?.includes(socket.id)} style={{ marginTop: '6px', padding: '7px 11px', borderRadius: '6px', border: trialDraftTargetId === null ? '1px solid #e2e8f0' : '1px solid rgba(255,255,255,0.16)', background: trialDraftTargetId === null ? 'rgba(255,255,255,0.17)' : 'rgba(255,255,255,0.04)', color: '#e2e8f0', cursor: 'pointer', boxShadow: trialDraftTargetId === null ? '0 0 20px rgba(255,255,255,0.25)' : 'none', animation: trialDraftTargetId === null ? 'trialSkipPulse 900ms ease-in-out infinite' : 'none', transition: 'all 0.25s ease-in-out' }}>⊘ {language === 'ru' ? 'ПРОПУСТИТЬ ГОЛОС' : 'SKIP VOTE'}</button>
                          <button onClick={() => setIsTrialChatOpen(open => !open)} style={{ marginTop: '6px', marginLeft: isMobile ? 0 : '6px', padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(0,240,255,0.25)', background: 'rgba(0,240,255,0.08)', color: '#8be7ff', cursor: 'pointer' }}>{language === 'ru' ? 'ЧАТ' : 'CHAT'} ({chatMessages.length})</button>
                          <button onClick={handleOpenClues} style={{ marginTop: '6px', marginLeft: isMobile ? 0 : '6px', padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(224,64,251,0.3)', background: 'rgba(224,64,251,0.08)', color: '#e29bff', cursor: 'pointer' }}>{language === 'ru' ? 'УЛИКИ' : 'CLUES'} ({clues.length})</button>
                          <button onClick={handleOpenBodies} style={{ marginTop: '6px', marginLeft: isMobile ? 0 : '6px', padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(255,143,168,0.3)', background: 'rgba(255,143,168,0.08)', color: '#ff8fa8', cursor: 'pointer' }}>{language === 'ru' ? 'ТЕЛА' : 'BODIES'} ({(trialFindings?.bodies || []).length})</button>
                          </div>
                        </div>
                      </div>

                      <p style={{ margin: '0 0 16px 0', color: '#bdc7db', lineHeight: 1.6 }}>
                        {language === 'ru'
                          ? 'Совещайтесь. Единственный подозреваемый с наибольшим числом голосов будет устранён; ничья или ничья с голосами «Пропустить» не приводит к устранению.'
                          : 'Deliberate. The sole suspect with the most votes is removed; any tie or Skip vote tie prevents an elimination.'}
                      </p>

                      {isEliminated || isObserver ? (
                        <div style={{ padding: '12px 14px', borderRadius: '12px', border: '1px solid rgba(255,42,95,0.2)', background: 'rgba(255,42,95,0.08)', color: '#ff8da6', marginBottom: '12px' }}>
                          {language === 'ru'
                            ? 'Вы наблюдаете за советом из камер внизу. Ваш голос больше не учитывается.'
                            : 'You are observing the council from the cells below. Your vote is no longer in play.'}
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
                        }) : <p style={{ margin: '8px 0', color: '#6272a4', fontSize: '12px' }}>{language === 'ru' ? 'Загрузка зашифрованных профилей агентов...' : 'Loading encrypted agent profiles...'}</p>}
                      </div>

                      {!isEliminated && !isObserver && trialData?.status === 'voting' && (
                        <div style={{ display: 'flex', gap: '8px', marginTop: '12px', alignItems: 'center' }}>
                          {trialData.confirmedVoterIds?.includes(socket.id) ? (
                            <><span style={{ flex: 1, color: '#76ffb4', fontSize: '11px', fontWeight: 800, letterSpacing: '1px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}><Icon name="check" size={13} />{language === 'ru' ? 'ГОЛОС ЗАФИКСИРОВАН' : 'VOTE LOCKED'}</span><button onClick={unlockTrialVote} style={{ padding: '9px 12px', borderRadius: '8px', border: '1px solid rgba(255,191,105,0.5)', background: 'rgba(255,191,105,0.1)', color: '#ffd28e', fontWeight: 800, cursor: 'pointer', transition: 'all 0.25s ease-in-out' }}>{language === 'ru' ? 'ИЗМЕНИТЬ ГОЛОС' : 'CHANGE VOTE'}</button></>
                          ) : trialDraftTargetId !== undefined ? (
                            <><button onClick={confirmTrialVote} style={{ flex: 1, padding: '10px 12px', borderRadius: '8px', border: '1px solid #00ff87', background: 'rgba(0,255,135,0.16)', color: '#76ffb4', fontWeight: 900, cursor: 'pointer', boxShadow: '0 0 18px rgba(0,255,135,0.15)', transition: 'all 0.25s ease-in-out' }}>{language === 'ru' ? 'ПОДТВЕРДИТЬ ГОЛОС' : 'CONFIRM VOTE'}</button><button onClick={() => setTrialDraftTargetId(undefined)} style={{ padding: '10px 12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.04)', color: '#c9d3e0', fontWeight: 800, cursor: 'pointer', transition: 'all 0.25s ease-in-out' }}>{language === 'ru' ? 'СБРОСИТЬ / ИЗМЕНИТЬ' : 'RESET / CHANGE'}</button></>
                          ) : <span style={{ color: '#8a99ad', fontSize: '11px', letterSpacing: '1px' }}>{language === 'ru' ? 'ВЫБЕРИТЕ ПОДОЗРЕВАЕМОГО ИЛИ ВОЗДЕРЖИТЕСЬ, ЗАТЕМ ЗАФИКСИРУЙТЕ ГОЛОС' : 'SELECT A SUSPECT OR ABSTAIN, THEN LOCK YOUR VOTE'}</span>}
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
                            {language === 'ru' ? 'ТЕРМИНАЛ ОТМЕНЫ — ВВЕДИТЕ КОД, ЧТОБЫ ЗАВЕРШИТЬ ИГРУ' : 'OVERRIDE TERMINAL — SUBMIT THE CODE TO END THE MATCH'}
                          </div>
                          {exitSealed ? (
                            <div style={{ fontSize: '10px', letterSpacing: '0.5px', color: '#ff8fa8', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <Icon name="lock" size={12} /> {language === 'ru' ? 'ЗАБЛОКИРОВАНО — где-то ещё осталось непроверенное тело.' : 'SEALED — a body is still out there, unaccounted for.'}
                            </div>
                          ) : (
                            <div style={{ fontSize: '10px', letterSpacing: '0.5px', color: '#8a99ad', marginBottom: '10px' }}>
                              {language === 'ru' ? 'Проверьте собранные цифры в верхнем правом углу.' : 'Check your collected digits in the top-right corner.'}
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
                              placeholder={exitSealed ? (language === 'ru' ? 'ВЫХОД ЗАБЛОКИРОВАН' : 'EXIT SEALED') : (language === 'ru' ? 'ВВЕДИТЕ КОД ОТМЕНЫ' : 'ENTER OVERRIDE CODE')}
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
                              {exitSealed ? (language === 'ru' ? 'ЗАБЛОКИРОВАНО' : 'SEALED') : (language === 'ru' ? 'ОТПРАВИТЬ КОД' : 'SUBMIT CODE')}
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
                      <div style={{ fontSize: '11px', letterSpacing: '2px', color: '#8a99ad' }}>{language === 'ru' ? 'ДОСЬЕ БАЗЫ ДАННЫХ' : 'DATABASE DOSSIER'}</div>
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
                          <div style={{ fontSize: '11px', color: '#00f0ff', letterSpacing: '1px' }}>{character?.name?.toUpperCase() || (language === 'ru' ? 'НЕИЗВЕСТНЫЙ АГЕНТ' : 'UNKNOWN AGENT')}</div>
                          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '8px', fontSize: isMobile ? '12px' : '11px', color: '#c9d3e0', lineHeight: 1.5 }}>
                            <span>{language === 'ru' ? 'НАСТОЯЩЕЕ ИМЯ' : 'REAL NAME'}: {dossier?.realName || (language === 'ru' ? 'ЗАСЕКРЕЧЕНО' : 'CLASSIFIED')}</span><span>{language === 'ru' ? 'РОСТ' : 'HEIGHT'}: {dossier?.height || '—'}</span>
                            <span>{language === 'ru' ? 'ВЕС' : 'WEIGHT'}: {dossier?.weight || '—'}</span><span>{language === 'ru' ? 'ГРУППА КРОВИ' : 'BLOOD'}: {dossier?.bloodType || '—'}</span>
                            <span style={{ gridColumn: isMobile ? 'auto' : '1 / -1' }}>{language === 'ru' ? 'УВЛЕЧЕНИЯ' : 'HOBBIES'}: {dossier?.hobbies || '—'}</span>
                          </div>
                          </div>
                        </div>;
                      })() : <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: '#6272a4', letterSpacing: '2px', fontSize: '13px' }}>{language === 'ru' ? 'ВЫБЕРИТЕ АГЕНТА ДЛЯ РАССЛЕДОВАНИЯ' : 'SELECT AN AGENT TO INVESTIGATE'}</div>}
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
                    <div style={{ fontSize: '10px', letterSpacing: '2px', color: '#e29bff', marginBottom: '8px' }}>🔍 {language === 'ru' ? 'КОНФИДЕНЦИАЛЬНО — ТОЛЬКО ДЛЯ ДЕТЕКТИВА' : 'CONFIDENTIAL — DETECTIVE EYES ONLY'}</div>
                    <div style={{ color: '#e2e8f0', lineHeight: 1.6, fontSize: '14px' }}>
                      <strong>{detectiveCheckResult.targetNickname}</strong> {language === 'ru' ? 'завершил свой последний ход в:' : 'ended their last turn in:'} <strong style={{ color: '#e29bff' }}>{translateRoomName(detectiveCheckResult.roomName, language)}</strong>
                    </div>
                    <button onClick={() => setDetectiveCheckResult(null)} style={{ marginTop: '16px', width: '100%', padding: '9px', borderRadius: '8px', border: '1px solid rgba(224,64,251,0.4)', background: 'rgba(224,64,251,0.1)', color: '#e29bff', fontWeight: 800, cursor: 'pointer' }}>{language === 'ru' ? 'ЗАКРЫТЬ' : 'CLOSE'}</button>
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
                    <div style={{ fontSize: '10px', letterSpacing: '2px', color: '#8be7ff', marginBottom: '8px' }}>🔒 {language === 'ru' ? 'КОНФИДЕНЦИАЛЬНО — ТОЛЬКО ДЛЯ ОФИЦЕРА' : 'CONFIDENTIAL — OFFICER EYES ONLY'}</div>
                    <div style={{ color: '#e2e8f0', lineHeight: 1.6, fontSize: '14px' }}>
                      <strong>{officerLockResult.targetNickname}</strong> {language === 'ru' ? 'будет заперт в' : 'will be locked in the'} <strong style={{ color: '#8be7ff' }}>{language === 'ru' ? 'Камере' : 'Holding Cell'}</strong> {language === 'ru' ? 'на весь следующий раунд.' : 'for the entirety of next round.'}
                    </div>
                    <button onClick={() => setOfficerLockResult(null)} style={{ marginTop: '16px', width: '100%', padding: '9px', borderRadius: '8px', border: '1px solid rgba(0,240,255,0.4)', background: 'rgba(0,240,255,0.1)', color: '#8be7ff', fontWeight: 800, cursor: 'pointer' }}>{language === 'ru' ? 'ЗАКРЫТЬ' : 'CLOSE'}</button>
                  </div>
                </div>
              )}
              {displayPhase === 'trial' && isTrialChatOpen && (
                <aside style={{ position: 'fixed', top: '18px', right: '18px', bottom: `${18 + bottomInset}px`, zIndex: 30, width: 'min(340px, calc(100vw - 36px))', padding: '14px', borderRadius: '12px', border: '1px solid rgba(0,240,255,0.25)', background: 'rgba(5,8,16,0.98)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: '#8be7ff', fontSize: '11px', letterSpacing: '1px' }}><span>{language === 'ru' ? 'ТАКТИЧЕСКИЙ ЧАТ' : 'TACTICAL CHAT'}</span><button onClick={() => setIsTrialChatOpen(false)} style={{ color: '#8be7ff', background: 'transparent', border: 0, cursor: 'pointer' }}>{language === 'ru' ? 'ЗАКРЫТЬ' : 'CLOSE'}</button></div>
                  <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>{chatMessages.map(message => <div key={message.id} style={{ padding: '8px', borderRadius: '8px', background: 'rgba(255,255,255,0.04)', fontSize: '12px' }}><div style={{ color: '#00f0ff', fontSize: '10px' }}>{message.senderNickname}</div>{message.text}</div>)}</div>
                  {(isEliminated || isObserver) && <div style={{ padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,42,95,0.35)', background: 'rgba(255,42,95,0.08)', color: '#ff9caf', fontSize: '11px', lineHeight: 1.45, transition: 'all 0.3s ease' }}>{language === 'ru' ? 'ВЫ УСТРАНЕНЫ И НЕ МОЖЕТЕ УЧАСТВОВАТЬ В ОБСУЖДЕНИЯХ ИЛИ ГОЛОСОВАНИИ СУДА.' : 'YOU ARE ELIMINATED AND CANNOT PARTICIPATE IN TRIAL DISCUSSIONS OR VOTING.'}</div>}
                  <form onSubmit={handleSendChatMessage} style={{ display: 'flex', gap: '6px' }}><input disabled={isEliminated || isObserver} value={draftChatMessage} onChange={(e) => setDraftChatMessage(e.target.value)} placeholder={isEliminated || isObserver ? (language === 'ru' ? 'Чат суда заблокирован для наблюдателей' : 'Trial chat locked for spectators') : (language === 'ru' ? 'Отправить сообщение' : 'Send a message')} style={{ minWidth: 0, flex: 1, padding: '8px', minHeight: '40px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.12)', background: '#0a0a0f', color: '#fff', fontSize: '16px', opacity: isEliminated || isObserver ? 0.45 : 1, transition: 'all 0.3s ease' }} /><button disabled={isEliminated || isObserver} type="submit" style={{ borderRadius: '6px', border: '1px solid rgba(0,240,255,0.3)', background: 'rgba(0,240,255,0.08)', color: '#8be7ff', padding: '8px 14px', minHeight: '40px', minWidth: '56px', opacity: isEliminated || isObserver ? 0.45 : 1 }}>{language === 'ru' ? 'ОТПРАВИТЬ' : 'SEND'}</button></form>
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
                            <button onClick={handleBackToCluesList} style={{ color: '#e29bff', background: 'transparent', border: 0, cursor: 'pointer', padding: 0, fontSize: '11px' }}>‹ {language === 'ru' ? 'НАЗАД' : 'BACK'}</button>
                            <button onClick={handleCloseClues} style={{ color: '#e29bff', background: 'transparent', border: 0, cursor: 'pointer' }}>{language === 'ru' ? 'ЗАКРЫТЬ' : 'CLOSE'}</button>
                          </div>
                          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            <div>
                              <p style={{ margin: '0 0 4px 0', fontSize: '10px', letterSpacing: '2px', color: '#8a99ad' }}>{language === 'ru' ? 'ДОСЬЕ УЛИКИ' : 'EVIDENCE DOSSIER'}</p>
                              <h4 style={{ margin: 0, fontSize: '18px', color: '#e2e8f0' }}>{translateEvidenceName(selectedClue.text, language)}</h4>
                            </div>
                            <div style={{ fontSize: '11px', color: '#8a99ad', letterSpacing: '1px' }}>
                              {language === 'ru' ? 'НАЙДЕНО В:' : 'FOUND IN:'} <span style={{ color: '#e2e8f0' }}>{translateRoomName(selectedClue.roomName, language)}</span>
                            </div>
                            <div style={{ fontSize: '11px', color: '#8a99ad', letterSpacing: '1px' }}>
                              {language === 'ru' ? 'НАЙДЕНО:' : 'FOUND BY:'}
                              <div style={{ marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                {selectedClue.foundBy.map((finder, idx) => (
                                  <span key={`${finder.nickname}_${idx}`} style={{ color: '#e2e8f0', fontSize: '12px' }}>
                                    {finder.nickname} <span style={{ color: '#6272a4' }}>({language === 'ru' ? `Раунд ${finder.round}` : `Round ${finder.round}`})</span>
                                  </span>
                                ))}
                              </div>
                            </div>
                            <div style={{ padding: '10px', borderRadius: '8px', background: 'rgba(255,255,255,0.04)', color: '#bdc7db', fontSize: '12px', lineHeight: 1.55 }}>
                              {translateEvidenceDescription(selectedClue.text, selectedClue.description, language) || (language === 'ru' ? 'Дополнительное описание отсутствует.' : 'No further description available.')}
                            </div>
                          </div>
                        </>
                      );
                    }
                    return (
                      <>
                        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#e29bff', fontSize: '11px', letterSpacing: '1px' }}><span>{language === 'ru' ? 'УЛИКИ' : 'CLUES'} ({clues.length})</span><button onClick={handleCloseClues} style={{ color: '#e29bff', background: 'transparent', border: 0, cursor: 'pointer' }}>{language === 'ru' ? 'ЗАКРЫТЬ' : 'CLOSE'}</button></div>
                        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          {clues.length === 0 && (
                            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: '#6272a4', letterSpacing: '1px', fontSize: '12px', padding: '20px 8px' }}>
                              {language === 'ru' ? 'УЛИКИ ПОКА НЕ НАЙДЕНЫ' : 'NO EVIDENCE FOUND YET'}
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
                                  {translateRoomName(clue.roomName, language)} · {language === 'ru' ? 'найдено:' : 'found by'} {clue.foundBy.map(f => f.nickname).join(', ')}
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
                                      ? (language === 'ru' ? 'ПРОВЕРКА…' : 'VERIFYING…')
                                      : onCooldown
                                        ? (language === 'ru'
                                            ? `ПРОВЕРИТЬ (ОСТАЛОСЬ ${forensicVerifyStatus.turnsRemaining} ХОД${forensicVerifyStatus.turnsRemaining === 1 ? '' : (forensicVerifyStatus.turnsRemaining >= 2 && forensicVerifyStatus.turnsRemaining <= 4 ? 'А' : 'ОВ')})`
                                            : `VERIFY (${forensicVerifyStatus.turnsRemaining} TURN${forensicVerifyStatus.turnsRemaining === 1 ? '' : 'S'} LEFT)`)
                                        : (language === 'ru' ? 'ПРОВЕРИТЬ' : 'VERIFY')}
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
                            <button onClick={handleBackToBodiesList} style={{ color: '#ff8fa8', background: 'transparent', border: 0, cursor: 'pointer', padding: 0, fontSize: '11px' }}>‹ {language === 'ru' ? 'НАЗАД' : 'BACK'}</button>
                            <button onClick={handleCloseBodies} style={{ color: '#ff8fa8', background: 'transparent', border: 0, cursor: 'pointer' }}>{language === 'ru' ? 'ЗАКРЫТЬ' : 'CLOSE'}</button>
                          </div>
                          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            <div>
                              <p style={{ margin: '0 0 4px 0', fontSize: '10px', letterSpacing: '2px', color: '#8a99ad' }}>{language === 'ru' ? 'ТЕЛО' : 'BODY'}</p>
                              <h4 style={{ margin: 0, fontSize: '18px', color: '#e2e8f0' }}>{selectedBody.nickname}</h4>
                            </div>
                            <div style={{ fontSize: '11px', color: '#8a99ad', letterSpacing: '1px' }}>
                              {language === 'ru' ? 'НАЙДЕНО В:' : 'FOUND IN:'} <span style={{ color: '#e2e8f0' }}>{translateRoomName(selectedBody.roomName, language)}</span>
                            </div>
                            <div style={{ fontSize: '11px', color: '#8a99ad', letterSpacing: '1px' }}>
                              {language === 'ru' ? 'НАЙДЕНО:' : 'FOUND BY:'}
                              <div style={{ marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                {(selectedBody.foundBy || []).length > 0
                                  ? selectedBody.foundBy.map((nickname, idx) => (
                                    <span key={`${nickname}_${idx}`} style={{ color: '#e2e8f0', fontSize: '12px' }}>{nickname}</span>
                                  ))
                                  : <span style={{ color: '#e2e8f0', fontSize: '12px' }}>{language === 'ru' ? 'Неизвестно' : 'Unknown'}</span>}
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
                                        ? `ОСМОТРЕТЬ (ОСТАЛОСЬ ${forensicVerifyStatus.turnsRemaining} ХОД${forensicVerifyStatus.turnsRemaining === 1 ? '' : (forensicVerifyStatus.turnsRemaining >= 2 && forensicVerifyStatus.turnsRemaining <= 4 ? 'А' : 'ОВ')})`
                                        : `EXAMINE (${forensicVerifyStatus.turnsRemaining} TURN${forensicVerifyStatus.turnsRemaining === 1 ? '' : 'S'} LEFT)`)
                                    : (language === 'ru' ? 'ОСМОТРЕТЬ ТЕЛО' : 'EXAMINE BODY')}
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
                                    {language === 'ru' ? 'СМОТРЕТЬ ОТЧЁТ' : 'VIEW REPORT'}
                                  </button>
                                )}
                              </div>
                            )}
                            <div style={{ padding: '10px', borderRadius: '8px', background: 'rgba(255,255,255,0.04)', color: '#bdc7db', fontSize: '12px', lineHeight: 1.55 }}>
                              {translateBodyDescription(selectedBody.character, selectedBody.description, language) || (language === 'ru' ? 'На месте происшествия больше ничего не обнаружено.' : 'The scene offers no further detail.')}
                            </div>
                          </div>
                        </>
                      );
                    }
                    return (
                      <>
                        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#ff8fa8', fontSize: '11px', letterSpacing: '1px' }}>
                          <span>{language === 'ru' ? 'ТЕЛА' : 'BODIES'} ({bodies.length})</span>
                          <button onClick={handleCloseBodies} style={{ color: '#ff8fa8', background: 'transparent', border: 0, cursor: 'pointer' }}>{language === 'ru' ? 'ЗАКРЫТЬ' : 'CLOSE'}</button>
                        </div>
                        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          {bodies.length === 0 && (
                            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: '#6272a4', letterSpacing: '1px', fontSize: '12px', padding: '20px 8px' }}>
                              {language === 'ru' ? 'ТЕЛА ПОКА НЕ НАЙДЕНЫ' : 'NO BODIES FOUND YET'}
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
                                  {translateRoomName(body.roomName, language)} · {language === 'ru' ? 'найдено:' : 'found by'} {(body.foundBy || []).length > 0 ? body.foundBy.join(', ') : (language === 'ru' ? 'Неизвестно' : 'Unknown')}
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
                                          ? `ОСМОТРЕТЬ (ОСТАЛОСЬ ${forensicVerifyStatus.turnsRemaining} ХОД${forensicVerifyStatus.turnsRemaining === 1 ? '' : (forensicVerifyStatus.turnsRemaining >= 2 && forensicVerifyStatus.turnsRemaining <= 4 ? 'А' : 'ОВ')})`
                                          : `EXAMINE (${forensicVerifyStatus.turnsRemaining} TURN${forensicVerifyStatus.turnsRemaining === 1 ? '' : 'S'} LEFT)`)
                                      : (language === 'ru' ? 'ОСМОТРЕТЬ ТЕЛО' : 'EXAMINE BODY')}
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
                                      {language === 'ru' ? 'СМОТРЕТЬ ОТЧЁТ' : 'VIEW REPORT'}
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
            <p style={{ margin: '0 0 8px 0', fontSize: '11px', letterSpacing: '3px', color: '#8a99ad' }}>{language === 'ru' ? 'ИГРА ЗАВЕРШЕНА' : 'MATCH CONCLUDED'}</p>
            <h2 style={{
              margin: '0 0 14px 0', fontSize: 'clamp(26px, 5vw, 42px)', fontWeight: 900,
              color: '#00ff87', textShadow: '0 0 30px rgba(0,255,135,0.5)', letterSpacing: '1px', textTransform: 'uppercase'
            }}>
              {gameOverData.winner === 'Innocent'
                ? (language === 'ru' ? 'ПОБЕДА КОМАНДЫ НЕВИННЫХ' : 'INNOCENT TEAM VICTORY')
                : gameOverData.winner === 'Joker'
                  ? (language === 'ru' ? 'ПОБЕДА ДЖОКЕРА' : 'JOKER VICTORY')
                  : (language === 'ru' ? `ПОБЕДА КОМАНДЫ ${gameOverData.winner || 'НЕИЗВЕСТНО'}` : `${gameOverData.winner || 'UNKNOWN'} TEAM VICTORY`)}
            </h2>
            <p style={{ margin: '0 0 22px 0', color: '#c9d3e0', lineHeight: 1.6, fontSize: '14px' }}>
              {translateGameOverMessage(gameOverData, language)}
              {gameOverData.digitalCode && (
                <><br /><span style={{ color: '#76ffb4', letterSpacing: '3px', fontFamily: 'Georgia, serif' }}>{language === 'ru' ? 'КОД ОТМЕНЫ' : 'OVERRIDE CODE'}: {gameOverData.digitalCode}</span></>
              )}
            </p>

            <div style={{ fontSize: '10px', letterSpacing: '2px', color: '#8a99ad', marginBottom: '10px' }}>{language === 'ru' ? 'ИТОГОВЫЕ РОЛИ' : 'FINAL ROLES'}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '20px' }}>
              {(gameOverData.roster || []).map(entry => (
                <div key={entry.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '8px 12px', borderRadius: '8px',
                  border: '1px solid rgba(255,255,255,0.08)',
                  background: entry.isEliminated ? 'rgba(255,42,95,0.06)' : 'rgba(255,255,255,0.03)'
                }}>
                  <span style={{ color: entry.isEliminated ? '#ff8da6' : '#e2e8f0', fontSize: '13px' }}>
                    {entry.nickname}{entry.isEliminated ? (language === 'ru' ? ' (устранён)' : ' (eliminated)') : ''}
                  </span>
                  <span style={{ fontSize: '12px', fontWeight: 800, letterSpacing: '1px', color: ROLES[entry.role]?.color || '#8a99ad' }}>
                    {(language === 'ru' ? ROLES[entry.role]?.labelRu : ROLES[entry.role]?.label) || entry.role || (language === 'ru' ? 'НЕИЗВЕСТНО' : 'UNKNOWN')}
                  </span>
                </div>
              ))}
            </div>

            <p style={{ margin: 0, fontSize: '11px', letterSpacing: '1px', color: '#6272a4', animation: 'introCaretBlink 1.6s ease-in-out infinite' }}>
              {language === 'ru' ? 'ВОЗВРАЩЕНИЕ В ЛОББИ...' : 'RETURNING TO LOBBY...'}
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
                {language === 'ru' ? 'МАТЕРИАЛЫ ДЕЛА — ЧТО НАЙДЕНО НА ДАННЫЙ МОМЕНТ' : "CASE FILE — WHAT'S BEEN FOUND SO FAR"}
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
                      ? (language === 'ru' ? 'Кто-то был убит, но тело ещё не найдено.' : 'Someone was killed, but the body hasn\u2019t been found yet.')
                      : (language === 'ru' ? `Убито агентов: ${trialFindings.undiscoveredCount}, но их тела ещё не найдены.` : `${trialFindings.undiscoveredCount} agents were killed, but their bodies haven't been found yet.`)}
                  </span>
                </div>
              )}
              {(trialFindings.bodies?.length || 0) === 0 && (trialFindings.clues?.length || 0) === 0 ? (
                trialFindings.undiscoveredCount > 0 ? null : (
                  <div style={{ fontSize: '13px', color: '#8a99ad', textAlign: 'center' }}>{language === 'ru' ? 'Пока ничего не найдено.' : 'Nothing has been found yet.'}</div>
                )
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {(trialFindings.bodies || []).map((body, idx) => (
                    <div key={`body-${idx}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#ff8fa8' }}>
                      <Icon name="skull" size={13} />
                      <span>{language === 'ru' ? `Тело ${body.nickname} — найдено в ${translateRoomName(body.roomName, language)}` : `${body.nickname}'s body — found in ${body.roomName}`}</span>
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
          aria-label={language === 'ru' ? 'Поддержать разработчика' : 'Support the developer'}
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
              alt={language === 'ru' ? 'Разработчик' : 'Developer'}
              style={{ width: '64px', height: '64px', borderRadius: '50%', objectFit: 'cover', marginBottom: '14px' }}
            />
            <p style={{ color: '#e6e9ef', fontSize: '14px', lineHeight: 1.6, margin: '0 0 20px 0' }}>
              {language === 'ru'
                ? 'Я инди-разработчик этой игры. Если вам нравится в неё играть, любая поддержка будет много значить для меня!'
                : "I'm an indie developer working on this game. If you enjoy playing it, any support would mean a lot to me!"}
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
              {language === 'ru' ? 'Поддержать на Boosty' : 'Support on Boosty'}
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
              {language === 'ru' ? 'Закрыть' : 'Close'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;