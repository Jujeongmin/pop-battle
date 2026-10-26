import { fullscreenAvailable, isExpanded, setExpanded, withFullscreenOffer } from '../ui/FullscreenPrompt';
import { CharacterShop } from '../net/characterShop';
import { installRetentionConsole } from '../net/retentionConsole';
import type { RetentionResult } from '../net/shared/retention';
import { isPaidCharacter } from '../net/shared/shop';
import { CoachMarks, type CoachStep } from '../ui/CoachMarks';
import type { RankingResult } from '../net/shared/ranking';
import { levelInfo } from '../net/shared/progression';
import { loadXpCache, saveXpCache } from '../net/progress';
import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadCharacterModel, loadGameAssets, type LoadedModel } from '../assets/loadAssets';
import { WeaponModelLibrary } from '../assets/weaponModels';
import { WeaponArt } from '../assets/weaponArt';
import { CharacterArt } from '../assets/characterArt';
import type { Bot } from '../bots/Bot';
import { BotManager } from '../bots/BotManager';
import { COMBAT, TEAMS } from '../config/combat';
import { FFA_RULES, NET_TEST_RULES } from '../config/match';
import { NET_MODE } from '../net/netConfig';
import { NetGameMode, type NetGameContext } from '../net/NetGameMode';
import { NetDebugPanel } from '../net/NetDebugPanel';
import { MultiplayerMenu } from '../net/MultiplayerMenu';
import { NetTestHud } from '../net/NetTestHud';
import type { LocalState } from '../net/NetSession';
import { checkNetRules, NET_MODE_RULES, NET_MODES, NET_TIMING, type NetMode } from '../net/shared/protocol';
import type { MatchRules } from '../config/match';
import {
  BOT_CHARACTERS,
  CHARACTER_DISPLAY_ORDER,
  CHARACTER_IDS,
  CHARACTER_SELECT,
  CHARACTERS,
  isCharacterSelectable,
  loadSavedCharacterId,
  setCharacterOwnership,
  KILL_FEED_COLORS,
  KILL_FEED_TEAM_COLORS,
  PLAYER_CHARACTER,
  saveCharacter,
  TEAM_PREVIEW,
  type CharacterId,
  type GameModeId,
  type TeamId,
} from '../config/characters';
import { syncedProtection } from '../net/spawnProtection';
import { CharacterAppearance, loadDeadEyes, loadTeamMask, type DeadEyes, type Expression } from '../player/CharacterAppearance';
import { Match, type MatchResult, type MatchState } from '../match/Match';
import { LocalPlayerOcclusion } from '../camera/LocalPlayerOcclusion';
import { TpsCamera } from '../camera/TpsCamera';
import { MuzzleDebug } from '../combat/MuzzleDebug';
import { ShotPathDebug } from '../combat/ShotPathDebug';
import { AimController } from '../combat/AimController';
import { WeaponEffects } from '../combat/WeaponEffects';
import { ToyBullets } from '../combat/ToyBullets';
import { Tracers } from '../combat/Tracers';
import {
  BULLET_CHARACTER_COLORS,
  BULLET_TEAM_COLORS,
  BULLET_VFX,
  bulletVfxIdOf,
  VFX_HEADSHOT,
  type BulletVfxId,
  type BulletVfxProfile,
  type VfxQuality,
} from '../config/bulletVfx';
import type { MeleeResult } from '../combat/melee';
import { WeaponSystem, type ShotPrediction, type ShotResult } from '../combat/WeaponSystem';
import { AudioManager } from '../audio/AudioManager';
import { Scoreboard, type ScoreRow } from '../ui/Scoreboard';
import { GameSounds, type SoundActor } from '../audio/GameSounds';
import { FIRE_SOUND, MIX, type MusicId } from '../config/audio';
import { CAMERA, CHARACTER, MOVEMENT, RENDER } from '../config/gameConfig';
import { assistTouchLook, type AssistTarget } from '../combat/aimAssist';
import { areHostile } from '../combat/teams';
import { MELEE_MOUNT, MELEE_WEAPON, PRIMARY_WEAPONS, RIFLE, RIFLE_MOUNT, SECONDARY_WEAPON, WEAPONS, type WeaponDef } from '../config/weapons';
import { initRapier, Physics } from '../physics/Physics';
import type { AttackerInfo, Damageable, HitInfo } from '../physics/Physics';
import { PlayerAvatar } from '../player/PlayerAvatar';
import { PlayerCombatant } from '../player/PlayerCombatant';
import { PlayerController } from '../player/PlayerController';
import { CharacterDebug, type DebugParticipant } from '../ui/CharacterDebug';
import { DebugPanel } from '../ui/DebugPanel';
import { setKillFeedWeaponIcons, type DeathCause, type KillFeedEvent } from '../ui/KillFeed';
import { Hud, type MatchHudInfo } from '../ui/Hud';
import { Lobby } from '../ui/lobby/Lobby';
import { PauseMenu } from '../ui/lobby/PauseMenu';
import type { LobbyHost, LobbyPresence, LobbySlider, LobbyWeapon, NicknameResult, PauseHost } from '../ui/lobby/lobbyDom';
import { loadUserSettings, saveUserSettings, USER_LIMITS } from './UserSettings';
import { TOUCH_LIMITS } from './TouchInput';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MAP_ID } from '../config/maps';
import type { GameMap, SpawnPoint } from '../world/GameMap';
import { ArenaMap } from '../world/maps/ArenaMap';
import { TestMap } from '../world/TestMap';
import { TestTarget } from '../world/TestTarget';
import { LobbySpace } from '../world/LobbySpace';
import { clearNickname, loadNickname, saveNickname } from '../net/nickname';
import { checkNickname, type NickFailReason } from '../net/shared/nickFilter';
import { errText, NetClient } from '../net/NetClient';
import { LobbyHub, type HubStatus } from '../net/LobbyHub';
import { LobbyPeers } from '../net/LobbyPeers';
import { displayCode } from '../net/NetSession';
import type { NetRoomSummary } from '../net/shared/protocol';
import { fromNetResult, fromPracticeResult } from '../result/resultData';
import { ResultStage } from '../result/ResultStage';
import { ResultScreen } from '../ui/result/ResultScreen';
import { GameInput } from './GameInput';
import { JoystickAutoSprint } from './JoystickAutoSprint';

/** 새로고침 뒤 메뉴에 "이전 방 다시 입장"을 보이기 위한 마지막 룸 (NetSession과 같은 키, 탭 단위) */
/** 닉네임 변경 간격 (서버 nickSet과 같은 10초, 서버 없는 빌드에서만 여기서 검사) */
const NICK_CHANGE_MS = 10_000;

/** 멀티플레이 원격 플레이어 (피해·처치는 서버 확정, id = net:<계정>) */
function isRemoteTarget(t: { id?: string } | undefined): boolean {
  return !!t?.id?.startsWith('net:');
}

function isNickReason(r: unknown): r is NickFailReason | 'rate' | 'taken' {
  return r === 'empty' || r === 'length' || r === 'chars' || r === 'blocked' || r === 'rate' || r === 'taken';
}

/** ms 안에 끝나지 않으면 실패 (서버 응답이 없을 때 화면이 멈춰 있지 않게) */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function readLastRoomCode(): string | null {
  try {
    return sessionStorage.getItem('popbattle.lastRoom');
  } catch {
    return null;
  }
}

/**
 * 로비 고정 구도 카메라: 방향은 고정(yaw 0 = 남쪽에서 북쪽을 봄), 캐릭터 위치만 부드럽게 따라감.
 * 마우스·터치로 돌지 않음. 장애물에 가리면 캐릭터 쪽으로 당김
 */
const LOBBY_CAM = { yaw: 0, distance: 6.4, height: 3.3, lookHeight: 0.8, followSharpness: 6, heightSharpness: 3.5, pullInSharpness: 5, easeOutSharpness: 2.2, wallSharpness: 30 };
/** 하늘 탑 기둥이 카메라를 가릴 때 투명도 (뒤쪽 나선 발판·캐릭터가 보이게) */
const LOBBY_PILLAR_ALPHA = 0.28;
/** 가림 때문에 당겨도 이보다 가까이 오지 않음 (m) */
const LOBBY_CAM_MIN_DIST = 1.6;

/** 로비 카메라 기준 키 (m): 캐릭터마다 줌을 바꾸지 않아 크기 차이가 보이게 */
const LOBBY_FRAME_HEIGHT = 1.4;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
/** 쇼케이스 카메라 가림 검사용 (보이는 로비 모습에 레이) */
const _showcaseRay = new THREE.Raycaster();

function dampAngle(current: number, target: number, sharpness: number, dt: number): number {
  const diff = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + diff * (1 - Math.exp(-sharpness * dt));
}

/** 게임 조립과 메인 루프. 각 모듈의 업데이트 순서를 여기서만 관리한다. */
/** 정비소 표시용 무기 종류 이름 */
const WEAPON_TYPE: Record<string, string> = { rifle: '돌격소총', shotgun: '산탄총', sniper: '저격총', pistol: '권총', melee: '근접무기' };

/** 로비 화면용 무기 정보 (표시만, 수치는 무기 설정 그대로) */
function lobbyWeapon(w: WeaponDef): LobbyWeapon {
  return { id: w.id, name: w.name, type: WEAPON_TYPE[w.id], stats: { damage: w.damage, pellets: w.pellets, rpm: w.rpm, range: w.range } };
}

/** 첫 플레이 안내 단계 (로비) */
const LOBBY_COACH: CoachStep[] = [
  { id: 'move', label: '이동', pc: 'WASD로 걸어 보세요', touch: '왼쪽 화면을 끌어 걸어 보세요' },
  { id: 'jump', label: '점프', pc: 'Space로 점프해 보세요', touch: '점프 버튼을 눌러 보세요' },
];
/** 첫 플레이 안내 단계 (첫 매치) */
const MATCH_COACH: CoachStep[] = [
  { id: 'move', label: '이동', pc: 'WASD로 이동해 보세요', touch: '왼쪽 화면을 끌어 이동해 보세요' },
  { id: 'look', label: '시점', pc: '마우스로 시점을 움직여 보세요', touch: '오른쪽 화면을 끌어 시점을 움직여 보세요' },
  { id: 'fire', label: '사격', pc: '좌클릭으로 사격', touch: '사격 버튼으로 사격' },
  { id: 'switch', label: '무기', pc: '1 · 2 · 3으로 무기 바꾸기', touch: '아래 무기 칸을 눌러 바꾸기' },
];

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly timer = new THREE.Timer();
  /** 키보드·마우스 + 모바일 터치 (같은 InputState로 합침) */
  private readonly input: GameInput;
  private readonly hud: Hud;
  private readonly audio = new AudioManager();
  /** 상태로 정하는 소리 (발소리·카운트다운·배경음·UI 클릭) */
  private sounds!: GameSounds;
  /** 결과 화면 배경음 (배너 동안 null = 조용히, 카드가 뜨면 승리·패배) */
  private resultMusic: MusicId | null = null;
  private readonly soundActors: SoundActor[] = [];
  /** 인게임 실시간 상황판 (PC Tab 누르는 동안 / 모바일 점수판 터치) */
  private scoreboard!: Scoreboard;
  /** 첫 플레이 안내 (로비: 이동·점프, 첫 매치: 이동·시점·사격·무기 교체) */
  private coach!: CoachMarks;
  private readonly resizeObserver = new ResizeObserver(() => this.resize());
  /** 모바일 조이스틱 자동 달리기 (입력 장치가 조이스틱일 때만) */
  private readonly autoSprint = new JoystickAutoSprint();

  private physics!: Physics;
  private map!: GameMap;
  private player!: PlayerController;
  private avatar!: PlayerAvatar;
  private tpsCamera!: TpsCamera;
  private occlusion!: LocalPlayerOcclusion;
  private aim!: AimController;
  private weapons!: WeaponSystem;
  private effects!: WeaponEffects;
  /** 시각용 장난감 탄환 (판정과 무관) */
  private bullets!: ToyBullets;
  private tracers!: Tracers;
  private debugPanel!: DebugPanel;
  /** 매치 일시정지 메뉴 (조작을 놓쳤을 때: ESC·터치 ‖·포인터 잠금 해제) */
  private pauseMenu: PauseMenu | null = null;
  /** 일시정지 조건이 처음 맞은 시각 (ms, -1 = 아님) */
  private pauseWantSince = -1;
  /** 유료 캐릭터 상점 (VXShop). 보유 = 서버 shopOwned, 지급 = 서버 $onItemPurchased */
  private readonly shop = new CharacterShop(async () => {
    try {
      if (this.netClient.status === 'no-verse') return null;
      if (!(await withTimeout(this.netClient.connect(), 10000))) return null;
      const r = await withTimeout(this.netClient.call<{ ok: boolean; chars: string[] }>('shopOwned'), 8000);
      return r.ok && Array.isArray(r.chars) ? r.chars : null;
    } catch (e) {
      this.netClient.addLog('warn', `보유 캐릭터 확인 실패: ${errText(e)}`);
      return null;
    }
  });
  /** 이번 매치에서 포인터 잠금을 한 번이라도 잡았는지 (못 잡았으면 일시정지 대신 마우스 고정 안내) */
  private matchLockSeen = false;
  /** 마지막으로 포인터 잠금을 잡은 시각 (잡자마자 풀리면 실패로 봄) */
  private lockedAt = -Infinity;
  /** 개발용 총구 표시 (개발 서버에서만 생성, 기본 꺼짐) */
  private muzzleDebug: MuzzleDebug | null = null;
  private shotDebug: ShotPathDebug | null = null;
  /** 이번 프레임 총구 방향 (월드) */
  private readonly muzzleDir = new THREE.Vector3();
  private targets: TestTarget[] = [];
  private combatant!: PlayerCombatant;
  private bots!: BotManager;
  /** 봇 캐릭터 (봇 순서대로, 다시 만들 때 외형용) */
  private botCharacterIds: CharacterId[] = [];
  /** 매치 진행 (개인전): 상태·타이머·킬데스 집계 */
  private match!: Match;
  /** 플레이어가 쓰는 스폰 지점 (매치 규칙: 개인전은 맵의 모든 스폰 공용) */
  private spawnPool: readonly SpawnPoint[] = [];
  /** 참가자별 외형 (캐릭터 원래 색 / 팀 색). 키 = 참가자 id */
  private readonly appearances = new Map<string, CharacterAppearance>();
  /** 외형 모드: FFA = 원래 색, TDM = 팀 색 (지금 매치는 개인전 → TDM은 ?teams=tdm 미리보기만) */
  private appearanceMode: GameModeId = 'FFA';
  /** 참가자 팀 (원래 캐릭터 색과 무관하게 배정) */
  private readonly teams = new Map<string, TeamId>();
  /** 캐릭터 GLB 캐시 (id → 원본, 아바타마다 SkeletonUtils.clone). 개발용 캐릭터 교체 때 다시 받지 않음 */
  private readonly characterModels = new Map<CharacterId, Promise<LoadedModel>>();
  /** 개발용 CHARACTER DEBUG (개발 서버에서만) */
  private characterDebug: CharacterDebug | null = null;
  /** 모바일 에임 보정 대상 (적 몸통 중심, 프레임마다 다시 채움 — 할당 없이 재사용) */
  private readonly assistTargets: AssistTarget[] = [];
  /** 디버그: 이번 프레임 에임 보정이 걸린 대상 (없으면 null) */
  aimAssistOn: string | null = null;
  /** 매치 결과 화면 (3D 무대 + 카드). 떠 있는 동안 경기장 대신 결과 무대를 그림 */
  private resultScreen: ResultScreen | null = null;
  /** 킬로그에 이미 올린 사망 (참가자 id, 리스폰하면 지움) → 같은 사망이 두 번 올라가지 않게 */
  private readonly feedDead = new Set<string>();
  /** 시작 화면 캐릭터 선택 순번 (불러오는 중 여러 번 누르면 마지막만 반영) */
  private characterSelectToken = 0;
  /** 플레이어 총구 위치 (매 프레임 갱신, 총구 화염이 따라감) */
  private readonly muzzle = new THREE.Vector3();
  private killedBy: string | null = null;
  private weaponModels!: WeaponModelLibrary;
  private weaponArt!: WeaponArt;
  /** 이번 프레임에 리스폰 반짝이를 띄울 아바타 */
  private readonly spawnFxQueue: PlayerAvatar[] = [];
  /** 멀티: 마지막 리스폰 응답의 보호 끝 시각 (서버 ms) / 낙사 부활 뒤 서버 응답 기다리는 중 */
  private netProtEnd = 0;
  private netProtAwait = false;
  /** 정비소 실시간 무기 미리보기 (캔버스·무기·각도, 바뀌었을 때만 그림) */
  private readonly weaponPreviews = new Set<{ canvas: HTMLCanvasElement; id: string; yaw: number; dirty: boolean }>();
  /** 캐릭터 초상 (정비소·대기실 카드): 같은 캐릭터 GLB 캐시로 한 번 그림 */
  private characterArt!: CharacterArt;
  /** 로드아웃: 주무기는 게임 시작 전에만 고를 수 있고, 시작(startMatch) 후에는 고정 (리스폰해도 유지) */
  private primary: WeaponDef = RIFLE;
  /** 현재 슬롯 (0 = 1번 주무기, 1 = 2번 권총, 2 = 3번 근접) */
  private slotIndex = 0;
  private disposed = false;

  private rafId = 0;
  private accumulator = 0;
  private bodyYaw = 0;
  private readonly aimDir = new THREE.Vector3(0, 0, 1);
  /** 몸 정면 (근접 판정 방향) */
  private readonly bodyForward = new THREE.Vector3(0, 0, 1);
  private readonly renderFeet = new THREE.Vector3();
  /** 안내 '이동' 단계: 입력이 있는 동안 실제로 움직인 거리 (키만 누르고 벽에 막힌 것은 아님) */
  private coachMoved = 0;
  private readonly coachLastFeet = new THREE.Vector3();
  private coachStepKey: string | null = null;
  private dead = false;
  private deathTimer = 0;
  private fpsFrames = 0;
  private fpsTime = 0;
  private fps = 0;
  private freezeAnim = false;
  /** 직전 프레임 총구 위치 (ADS 총구 수렴 계산용) */
  private readonly lastMuzzle = new THREE.Vector3();
  /** 멀티플레이 테스트 (Multiplayer Test 메뉴로 방에 들어가면 생성, 아니면 null → 싱글플레이 그대로) */
  private net: NetGameMode | null = null;
  private netPanel: NetDebugPanel | null = null;
  /** 시작 화면 "Multiplayer Test" 메뉴 (항상 생성, 서버 연결은 방 만들기/입장 때) */
  private mpMenu: MultiplayerMenu | null = null;
  private netHud: NetTestHud | null = null;
  /** 멀티 게임으로 전환됨 (봇 제거, 최대 8인 규칙) */
  private netGame = false;
  /** 직접 나가기로 룸에서 나옴 (연결 끊김과 구분해 메뉴 화면을 고름) */
  private netLeftByUser = false;
  /** 테스트 시작 때 자리별 스폰 (한 번만 사용) */
  private netSpawn: SpawnPoint | null = null;
  private mpRefreshTimer = 0;
  /** 마지막으로 반영한 서버 모드·팀 (바뀔 때만 외형 다시 적용) */
  private netModeKey = '';
  /** 리스폰 요청 중 (서버 승인 대기) */
  private netRespawnPending = false;
  /** 이번 프레임 자세 값 (네트워크 상태 패킷용) */
  private netPitch = 0;
  private netStrafing = false;
  /** 개발용: 캐릭터 주위를 도는 검사 카메라 (콘솔에서 __game.inspectOrbit = { yaw, pitch, distance }) */
  inspectOrbit: { yaw: number; pitch: number; distance: number; height?: number; focusRifle?: boolean } | null = null;
  /** 디버그 패널 "자세 보기 카메라": 캐릭터 정면 기준 각도(도, 0 = 정면, -90 = 오른쪽, 180 = 뒤) */
  private poseView = { on: false, angleDeg: -45, pitchDeg: 7, distance: 1.6 };
  /** 메인 로비 (게임 시작 전). 첫 매치·멀티 입장 뒤에는 다시 뜨지 않음 (로비로 = 새로고침) */
  private lobby: Lobby | null = null;
  private lobbyDone = false;
  private lobbyShown = false;
  private lobbyTime = 0;
  /** 로비 3D 캐릭터를 둘 화면 가로 위치 (px, 패널·메뉴를 피한 빈 공간 가운데, null = 화면 가운데) / 지금 적용된 화면 이동량 */
  private lobbyCenterX: number | null = null;
  /** 로비 방 목록 칸 아래 끝 (px) / 그만큼 화면을 내린 양 (view offset, 부드럽게) */
  private lobbyUiArea: { top: number; bottom: number; left: number; right: number } | null = null;
  /** 로비 화면 이동량 가로 (px, view offset) */
  private lobbyLiftX = 0;
  private lobbyLift = 0;
  private lobbyShift = 0;
  /**
   * 쇼케이스: 카메라를 둘 수 있는 트인 방향으로 미리보기 캐릭터를 돌리는 각도 (캐릭터 방향 기준, 0 = 그대로).
   * 카메라는 늘 캐릭터 정면 3/4(28°)에서 봄 → 무대 턱 등이 앞을 막아도 몸이 잘리지 않고 뒷모습도 안 나옴
   */
  private showcaseFace = 0;
  private showcaseYawFor = '';
  /** 사용자 설정 (소리·마우스 감도, 이 기기 저장) */
  private readonly userSettings = loadUserSettings();
  /**
   * 로비 3D 미리보기 전용 아바타 (정비소에서 잠긴 캐릭터도 볼 수 있게 실제 플레이어 아바타와 분리).
   * 같은 GLB 캐시를 복제, 무기는 복제본, 팀 색 없이 기본 외형. 바꿀 때 이전 것은 해제, 로비가 닫히면 해제
   */
  private preview: { avatar: PlayerAvatar; id: CharacterId; weaponId: string } | null = null;
  private previewWant: CharacterId | null = null;
  private previewToken = 0;
  /** 미리보기 드래그 회전 (rad, 정면 기준) / 교체 연출 (0→1) */
  private previewSpin = 0;
  private previewPop = 1;
  private previewBuilding = '';
  /** 로비 전용 공간 (하늘 놀이섬). 첫 매치·멀티 입장 때 해제 (로비는 다시 열리지 않음) */
  private lobbySpace: LobbySpace | null = null;
  /** TAB 메뉴 열림 / 열린 패널 (로비가 menuChanged로 알림) */
  private lobbyMenuOpen = false;
  private lobbyPanel: string | null = null;
  /** 정비소 카메라 전환 (0 = 자유 이동 TPS 카메라, 1 = 캐릭터 정면 쇼케이스) */
  private showcaseBlend = 0;
  /** 로비 HUD에 마지막으로 알린 조작 상태 (바뀔 때만 알림) */
  private lobbyRoamKey = '';
  /** 로비 카메라가 따라가는 지점 (부드럽게 캐릭터 발을 따라감) */
  private readonly lobbyFollow = new THREE.Vector3();
  private lobbyFollowReady = false;
  /** 로비 카메라 방향 (기본 고정, 하늘 탑 근처에서만 보정) — 이동 방향 기준도 이것 */
  private lobbyCamYaw = LOBBY_CAM.yaw;
  /** 로비 카메라 현재 거리 (가림 회피로 줄었다가 천천히 돌아감) */
  private lobbyCamDist = Math.hypot(LOBBY_CAM.distance, LOBBY_CAM.height);
  /** 표시용 닉네임 (이 기기 저장, null = 아직 정하지 않음) */
  private nick: string | null = loadNickname();
  /** 내 누적 경험치 (서버 저장값의 사본: 접속 때 progressGet, 멀티 매치 종료 때 서버 지급 결과로 갱신) */
  private myXp = loadXpCache();
  /** 마지막 닉네임 변경 시각 (서버 없는 빌드의 변경 간격 제한) */
  private nickChangedAt = -Infinity;
  /** 서버 닉네임 확인 끝남 (그 전에는 첫 설정 창을 열지 않음) */
  private nickReady = false;
  /** 서버가 알려 준 '닉네임 변경 필요' (운영 정책에 맞지 않는 예전 이름) */
  private nickMustChange = false;
  /** 저장 중인 닉네임 요청 (중복 전송 방지) */
  private nickSaving: Promise<NicknameResult> | null = null;
  /** 서버 연결 (온라인 로비·매치 공용: 같은 계정은 SDK 연결이 하나) */
  private readonly netClient = new NetClient();
  /** 온라인 로비 세션·다른 사람 캐릭터 (로비 단계에서만 접속) */
  private hub: LobbyHub | null = null;
  private peers: LobbyPeers | null = null;
  /** 매치 룸 입장 처리 중 (로비 재접속 보류) */
  private hubHold = false;
  /** 현재 룸 전환. 로비 복귀 요청은 진행 중 전환 뒤에 이어서 처리해 탭을 버리지 않는다. */
  private roomTransition: Promise<void> | null = null;
  /** 멀티 입장 때 봇을 지움 → 이후 연습전은 새로고침으로 */
  private botsRemoved = false;
  /** 개발 진단 로그 타이머 (로비 전송량·FPS) */
  private hubLogTimer = 0;
  private readonly abort = new AbortController();

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    const coarsePointer = matchMedia('(hover: none) and (pointer: coarse)').matches;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, coarsePointer ? RENDER.mobileMaxPixelRatio : RENDER.maxPixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.input = new GameInput(this.renderer.domElement, container);
    this.hud = new Hud(container);
    // 모바일 터치 조작: HUD 배치(버튼 자리 비움)·슬롯 터치·터치 설정
    this.hud.setTouchMode(this.input.touchMode);
    this.input.onTouchModeChange = (on) => {
      this.hud.setTouchMode(on);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, on ? RENDER.mobileMaxPixelRatio : RENDER.maxPixelRatio));
      this.resize();
    };
    this.hud.onSlotTap = (i) => this.input.touch.pressSlot(i + 1);
    this.hud.onTouchSettings = () => this.input.touch.openSettings();
    this.hud.onTouchStart = () => this.input.requestLock();
    // 소리: 첫 사용자 입력(클릭·터치·키)에서 오디오 시작 (모바일 자동 재생 제한), UI 클릭음은 화면 전체 위임
    this.audio.attachUnlock(window);
    this.sounds = new GameSounds(this.audio, container);
    this.scoreboard = new Scoreboard(container);
    this.coach = new CoachMarks(container);
    this.scoreboard.onClose = () => this.scoreboard.setOpen(false);
    this.hud.onMatchBarTap = () => this.scoreboard.setOpen(!this.scoreboard.open && this.scoreboardAllowed);
    window.addEventListener('keyup', this.onScoreboardKeyUp, { signal: this.abort.signal, capture: true });
    window.addEventListener('blur', () => this.scoreboard.setOpen(false), { signal: this.abort.signal });
    this.input.kbm.onLockError = () => this.onLockFailed();
    // 결과 화면에서는 커서로 버튼을 눌러야 함: 빈 곳 클릭(결과 화면은 클릭을 통과시킴)이 캔버스에 닿아도 다시 잠그지 않음
    this.input.kbm.lockAllowed = () => !this.resultScreen?.open;
    this.input.onLockChange = (locked) => {
      this.hud.setLocked(locked);
      if (locked && !this.inLobby) {
        this.matchLockSeen = true;
        this.lockedAt = performance.now();
      } else if (!locked && !this.inLobby && !this.input.touchMode && performance.now() - this.lockedAt < 1500 && this.input.kbm.lastUnlock !== 'esc') {
        // 잡자마자(1.5초 안) ESC가 아닌 이유로 풀림 → 같은 일시정지가 반복되지 않게 실패로 보고 안내 화면으로
        this.input.kbm.lockErrors++;
        this.onLockFailed();
      }
      // 브라우저 자동 재생 정책: 사용자 클릭(포인터 잠금) 뒤에 오디오 시작
      if (locked) this.audio.unlock();
      // 로비는 포인터 잠금을 쓰지 않음 (커서 보이는 자유 이동). 매치는 기존처럼 잠금 = 시작
      if (this.inLobby) return;
      if (locked) this.startMatch();
    };
    // 로비 TAB 메뉴: 로비가 떠 있을 때만 TAB을 가로챔 (글자 입력 칸에 포커스가 있으면 브라우저 기본 동작 그대로)
    window.addEventListener('keydown', this.onLobbyKey, { signal: this.abort.signal, capture: true });
  }

  /** 게임 시작 전 로비 단계 (멀티 메뉴가 덮고 있어도 로비 단계) */
  private get inLobby(): boolean {
    return !!this.lobby && !this.lobbyDone;
  }

  private readonly onLobbyKey = (e: KeyboardEvent): void => {
    if (e.code !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return;
    const t = e.target as HTMLElement | null;
    const typing =
      !!t && (t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes((t as HTMLInputElement).type)));
    if (typing) return;
    // 매치 중: Tab을 누르는 동안 상황판 (브라우저 포커스 이동 막음, 반복 입력은 무시 → 깜빡임 없음)
    if (!this.lobbyShown) {
      if (!this.scoreboardAllowed) return;
      e.preventDefault();
      if (!e.repeat) this.scoreboard.setOpen(true);
      return;
    }
    e.preventDefault();
    if (!e.repeat) this.lobby!.toggleMenu();
  };

  private readonly onScoreboardKeyUp = (e: KeyboardEvent): void => {
    if (e.code !== 'Tab' || !this.scoreboard.open) return;
    e.preventDefault();
    this.scoreboard.setOpen(false);
  };

  /** 상황판을 열 수 있음: 매치 진행 중(카운트다운·전투), 일시정지·결과 화면·로비가 아닐 때 */
  private get scoreboardAllowed(): boolean {
    return this.matchRunning && !this.lobbyShown && !this.pauseMenu?.visible && !this.resultScreen?.open && this.match.state !== 'FINISHED';
  }

  /** 상황판 데이터 (열려 있을 때 매 프레임): 멀티 = 서버 기록(나간 사람 포함, 결과 화면과 같은 값), 연습전 = 로컬 기록 */
  private updateScoreboard(): void {
    const sb = this.scoreboard;
    if (!sb.open) return;
    if (!this.scoreboardAllowed) {
      sb.setOpen(false);
      return;
    }
    const s = this.net?.session;
    if (this.netGame && s) {
      const rule = NET_MODE_RULES[s.mode];
      const myName = s.nickOf(s.me) ?? this.nick ?? '나';
      const rows: ScoreRow[] = [
        ...Object.entries(s.players).map(([acc, p]) => ({ id: acc, name: acc === s.me ? myName : s.displayName(acc), k: p.k, d: p.d, me: acc === s.me, team: p.team ?? null, left: false, order: p.slot, level: p.lv ?? 1 })),
        ...Object.values(s.gone).map((g) => ({ id: g.account, name: s.displayName(g.account), k: g.k, d: g.d, me: false, team: g.team ?? null, left: true, order: g.slot + 100, level: g.lv ?? 1 })),
      ];
      sb.update({ teams: rule.teams, label: rule.short, timeLeft: this.netScoreHud()?.timeLeft ?? null, blue: s.teamScore.BLUE, red: s.teamScore.RED, goal: rule.scoreToWin, rows });
      return;
    }
    const m = this.match;
    const rows: ScoreRow[] = m.stats.standings().map((st, i) => ({
      id: st.id,
      name: st.isLocal ? (this.nick ?? '나') : (this.bots.bots.find((b) => b.id === st.id)?.name ?? st.name),
      k: st.kills,
      d: st.deaths,
      me: st.isLocal,
      team: null,
      left: false,
      order: i,
      // 연습전: 내 레벨만 (봇은 계급 없음)
      level: st.isLocal ? levelInfo(this.myXp).level : null,
    }));
    sb.update({ teams: false, label: '연습전 · 개인전', timeLeft: m.timeLeft, blue: 0, red: 0, goal: m.rules.scoreToWin, rows });
  }

  async init(onProgress: (text: string) => void): Promise<void> {
    onProgress('물리 엔진 초기화…');
    await initRapier();
    this.physics = new Physics(RENDER.fixedStep);

    onProgress('3D 에셋 로딩…');
    const assets = await loadGameAssets(this.renderer);

    onProgress('맵 불러오는 중…');
    // 맵 선택: 기본 POP! ARENA, ?map=test 이면 기존 테스트 맵 (둘 중 하나만 생성)
    this.map =
      MAP_ID === 'test'
        ? new TestMap(this.scene, this.physics)
        : await ArenaMap.create(this.scene, this.physics, new GLTFLoader(), Math.min(4, this.renderer.capabilities.getMaxAnisotropy()));
    const firstSpawn = this.map.spawns.teamA[0]!;
    const spawn = new THREE.Vector3(firstSpawn.x, firstSpawn.y + 0.7, firstSpawn.z);
    this.player = new PlayerController(this.physics, spawn);
    // 봇은 같은 GLB를 복제해 쓴다: 플레이어 아바타가 원본을 바꾸기 전에 복제본 확보
    // 봇 캐릭터: ?botchars= 순서대로 (기본은 플레이어와 같은 캐릭터)
    const botCharacterIds: CharacterId[] = [0, 1, 2].map((i) => BOT_CHARACTERS[i] ?? PLAYER_CHARACTER);
    this.botCharacterIds = botCharacterIds;
    this.characterModels.set(PLAYER_CHARACTER, Promise.resolve(assets.character));
    for (const [id, m] of assets.otherCharacters) this.characterModels.set(id, Promise.resolve(m));
    const botSources = {
      characters: botCharacterIds.map((id) => ({ id, ...(id === PLAYER_CHARACTER ? assets.character : assets.otherCharacters.get(id)!) })),
      rifle: assets.rifle.scene.clone(true),
    };
    // 무기 모델: GLB가 있으면 GLB, 없으면 임시 도형 (무기당 1회 생성 후 재사용)
    this.weaponModels = new WeaponModelLibrary(new Map([[RIFLE.id, assets.rifle.scene], ...assets.weapons]));
    // 무기 그림 (킬로그 실루엣·정비소·상점): 같은 모델을 게임 렌더러로 한 번 그려 이미지로
    this.weaponArt = new WeaponArt(this.renderer, this.weaponModels, WEAPONS);
    this.characterArt = new CharacterArt(this.renderer, (id) => this.loadCharacter(id as CharacterId));
    this.resultScreen = new ResultScreen(this.container, new ResultStage((id) => this.loadCharacter(id)), {
      replay: () => this.replay(),
      toRoom: async () => {
        const s = this.net?.session;
        if (!s?.inRoom) return false;
        return (await s.toLobby()).ok;
      },
      toMainLobby: () => this.returnToLobby(),
      // 종료 배너: 승리·패배 효과음 + 전투 음악 끔 → 카드가 뜨면 결과 효과음 + 승리·패배 음악 (무승부는 차분한 곡)
      onPhase: (phase, data) => {
        if (phase === 'banner') {
          this.resultMusic = null;
          if (data.outcome !== 'draw') this.audio.play(data.outcome === 'win' ? 'win' : 'lose');
        } else {
          this.audio.play('resultShow');
          this.resultMusic = data.outcome === 'win' ? 'victory' : 'defeat';
        }
      },
    });
    // 킬로그 무기 아이콘 = 실제 모델 실루엣 (처음 처치 때 멈칫하지 않게 미리 그림)
    for (const id of Object.keys(WEAPONS)) this.weaponArt.silhouette(id);
    setKillFeedWeaponIcons((id) => this.weaponArt.silhouette(id));
    // 우측 하단 무기 카드도 실제 무기 그림
    this.hud.weaponImage = (id) => this.weaponArt.image(id);
    // 원본 씬은 캐시에 남겨 두고 복제본 사용 (개발용 캐릭터 교체 때 다시 복제)
    this.avatar = new PlayerAvatar(SkeletonUtils.clone(assets.character.scene), assets.character.clips, assets.rifle.scene, RIFLE_MOUNT, PLAYER_CHARACTER);
    this.scene.add(this.avatar.root);
    this.occlusion = new LocalPlayerOcclusion(this.avatar);
    this.combatant = new PlayerCombatant(this.physics, this.player, this.avatar, (hit, applied) => this.onPlayerDamaged(hit, applied));
    this.combatant.health.reset(COMBAT.player.spawnProtection);

    this.tpsCamera = new TpsCamera(1, this.physics, this.player.collider);
    this.bodyYaw = 0;
    this.tpsCamera.snapBehind(this.bodyYaw, spawn);
    this.applyPlayerCharacterStats();
    this.aim = new AimController();
    this.effects = new WeaponEffects(this.scene);
    this.bullets = new ToyBullets(this.scene);
    this.tracers = new Tracers(this.scene);
    this.tracers.low = this.bullets.quality === 'low';
    // 판정(WeaponSystem)은 결과만 내보내고, 연출(이펙트·사운드·HUD)은 여기서 결과를 보고 처리
    this.weapons = new WeaponSystem(RIFLE, this.physics, this.aim, this.player.body, () => this.combatant.attacker(this.muzzle), {
      onFire: (muzzle, def) => {
        this.effects.muzzleFlash(muzzle, this.muzzle, def.effects.flashScale);
        this.muzzlePop(muzzle, this.muzzleDir, def.id, this.combatant.id);
        this.muzzleDebug?.onFlash(muzzle, this.muzzle);
        this.audio.play(FIRE_SOUND[def.id] ?? 'fireRifle');
        this.combatant.notifyFired();
      },
      onShot: (r) => {
        this.presentShot(r);
        this.shotDebug?.add(r);
        this.net?.recordShot(r);
      },
      onVolley: (shots) => this.presentVolley(shots),
      onMeleeSwing: () => {
        this.audio.play('swing');
        // 근접 공격도 공격 → 리스폰 보호 해제 (총소리는 아니라 봇 청각 감지는 안 함)
        this.combatant.health.breakProtection();
      },
      onMelee: (r) => {
        this.presentMelee(r);
        this.net?.recordMelee(r, this.muzzle);
      },
      onReload: (phase) => this.audio.play(phase === 'start' ? 'reloadStart' : 'reloadEnd'),
      onDryFire: () => this.audio.play('dryFire'),
      onRecoil: (p, y, ratio, sharp) => this.tpsCamera.addRecoil(p, y, ratio, sharp),
    });
    this.input.touch.setWeapon(this.weapons.def.id);

    const targetSpecs = [
      { name: '표적 분홍', position: new THREE.Vector3(-3, 0, 14), color: 0xff9ec7 },
      { name: '표적 노랑', position: new THREE.Vector3(0, 0, 18), color: 0xffd45e },
      { name: '표적 파랑', position: new THREE.Vector3(3, 0, 18), color: 0x6fa8ff },
      { name: '표적 민트(이동)', position: new THREE.Vector3(6, 0, 22), color: 0x8fe3c8, patrol: { amplitude: 3, period: 4 } },
      { name: '표적 주황', position: new THREE.Vector3(-10, 0, 20), color: 0xff9c5b },
      { name: '표적 발판', position: new THREE.Vector3(12, 1.5, -11), color: 0xff9ec7 },
    ];
    // 테스트 표적(기본 도형)은 테스트 맵에서만
    if (this.map.hasTestTargets) this.targets = targetSpecs.map((s) => new TestTarget(this.physics, this.scene, s));

    // 매치 규칙: 적대 규칙(개인전 = 모두 적)은 봇 생성 전에 적용
    const rules = FFA_RULES;
    COMBAT.hostility = rules.hostility;
    const allSpawns = [...this.map.spawns.teamA, ...this.map.spawns.teamB];
    this.spawnPool = rules.spawns === 'all' ? allSpawns : this.map.spawns.teamA;

    onProgress('봇 준비…');
    // 이동 격자는 Rapier 형상 검사로 굽는다 → 맵 콜라이더가 쿼리 구조에 들어간 뒤(물리 1스텝 후)에 만들어야 함
    this.physics.step();
    this.bots = new BotManager(this.physics, this.scene, botSources, RIFLE_MOUNT, RIFLE, this.combatant, {
      onFire: (bot, muzzle) => {
        this.effects.muzzleFlash(muzzle, bot.muzzle);
        this.muzzlePop(muzzle, bot.aimDir, bot.weapon.def.id, bot.id);
        this.audio.play(FIRE_SOUND[bot.weapon.def.id] ?? 'fireRifle', { pos: muzzle, gain: MIX.otherGain, channel: 'otherFire' });
      },
      onShot: (_bot, r) => this.presentShot(r),
      onReload: (bot, phase) =>
        this.audio.play(phase === 'start' ? 'reloadStart' : 'reloadEnd', { pos: bot.muzzle, gain: MIX.otherGain * 0.7, channel: 'otherReload' }),
      // 킬·데스 집계 (PLAYING에서만, 한 번의 사망에 한 번)
      onDeath: (bot, killer, hit) => {
        this.match.recordDeath(bot.id, killer?.id ?? null);
        this.reportDeath(bot.id, killer, hit, 'weapon');
        // 사망 표정 (사망 애니메이션과 같은 프레임부터, 리스폰 전까지 유지)
        this.appearances.get(bot.id)?.setDead(true);
      },
      onRespawn: (bot) => {
        this.queueSpawnFx(bot.avatar);
        this.feedDead.delete(bot.id);
        this.appearances.get(bot.id)?.setDead(false);
        this.match.respawned(bot.id);
        this.applyAppearance(bot.id);
      },
    }, this.map);
    if (rules.spawns === 'all') this.bots.setSpawnPool(allSpawns);
    // 매치: 플레이어 + 봇 등록, 시작 전(WAITING)에는 봇 대기
    this.match = new Match(rules, {
      onStateChange: (state, prev) => this.onMatchState(state, prev),
      onFinish: (result) => this.onMatchFinish(result),
    });
    this.match.stats.register({ id: this.combatant.id, name: '나', isLocal: true });
    for (const b of this.bots.bots) this.match.stats.register({ id: b.id, name: b.name, isLocal: false });
    if (this.match.stats.count !== rules.players) console.warn(`[match] 참가자 ${this.match.stats.count}명 (규칙 ${rules.players}명)`);
    this.bots.hold = true;

    // 외형: 캐릭터별 팀 마스크(캐릭터당 1장) + 인스턴스별 머티리얼 패치. FFA는 원래 색
    onProgress('캐릭터 외형…');
    {
      const [mask, deadEyes] = await Promise.all([loadTeamMask(CHARACTERS[PLAYER_CHARACTER]), this.loadDeadEyesSafe(PLAYER_CHARACTER)]);
      this.appearances.set(this.combatant.id, this.createAppearance(this.avatar.bodyMeshes, PLAYER_CHARACTER, mask, deadEyes));
    }
    await this.setupBotAppearances();
    this.setTeamPreview(TEAM_PREVIEW);
    // 첫 스폰도 리스폰과 같은 규칙 (봇이 생긴 뒤 위치 확정)
    this.placeAtSpawn(this.pickPlayerSpawn());

    const pv = this.poseView;
    this.debugPanel = new DebugPanel(
      this.container,
      RIFLE_MOUNT,
      () => this.avatar.applyMount(),
      [
        { label: '무적 (플레이어 피해 0, 콘솔 __game.god())', get: () => this.combatant.invincible, set: (v) => this.god(v) },
        { label: '애니메이션 정지 (포즈 확인)', get: () => this.freezeAnim, set: (v) => (this.freezeAnim = v) },
        { label: '자세 보기 카메라 (캐릭터 주위)', get: () => pv.on, set: (v) => this.setPoseView(v) },
        { label: '그립/총구 마커 표시', get: () => this.avatar.showMarkers, set: (v) => (this.avatar.showMarkers = v) },
        { label: '총구 디버그 (점·방향선·발사 위치)', get: () => !!this.muzzleDebug?.enabled, set: (v) => this.setMuzzleDebug(v) },
        { label: '사격 경로 디버그 (카메라 조준·총구 탄 경로·충돌, 콘솔 __game.setShotDebug())', get: () => !!this.shotDebug?.enabled, set: (v) => this.setShotDebug(v) },
        { label: '캐릭터 메시 숨김', get: () => false, set: (v) => (this.avatar.hideBody = v) },
        { label: '봇 경로 표시', get: () => this.bots.showPaths, set: (v) => (this.bots.showPaths = v) },
      ],
      {
        mount: MELEE_MOUNT,
        equipped: () => this.weapons.def.mount === MELEE_MOUNT,
        solveGrip: () =>
          this.weapons.def.mount === MELEE_MOUNT &&
          this.avatar.solveRightGripToForearm([0, MELEE_MOUNT.swing?.gripCenterY ?? 0, MELEE_MOUNT.rightGrip[2]]),
      },
      [
        { label: '보기 각도(0 정면, -90 오른쪽)', min: -180, max: 180, step: 5, get: () => pv.angleDeg, set: (v) => (pv.angleDeg = v) },
        { label: '보기 높이(도)', min: -30, max: 60, step: 1, get: () => pv.pitchDeg, set: (v) => (pv.pitchDeg = v) },
        { label: '보기 거리(m)', min: 0.8, max: 4, step: 0.1, get: () => pv.distance, set: (v) => (pv.distance = v) },
      ],
    );

    if (import.meta.env.DEV) {
      this.characterDebug = new CharacterDebug(this.scene, {
        participants: () => this.debugParticipants(),
        select: (who, id) => this.setCharacter(who, id),
        setExpression: (who, e) => this.setExpression(who, e),
      });
      this.debugPanel.prepend(this.characterDebug.element);
      this.debugPanel.prepend(this.killFeedTestSection());
      this.debugPanel.prepend(this.bulletVfxSection());
    }

    // 멀티플레이 테스트 메뉴 (시작 화면 버튼). ?net=1이면 바로 열림
    this.initMultiplayerMenu();
    if (NET_MODE) this.mpMenu?.open();

    // 로드아웃 선택 UI (시작 화면 카드). 시작 전에만 바꿀 수 있다
    // 캐릭터 선택 (시작 화면 카드). 시작 전에만, 잠긴 캐릭터는 배포 빌드에서 선택 불가
    this.hud.setCharacterOptions(
      CHARACTER_IDS.map((id) => {
        const c = CHARACTERS[id];
        const sel = CHARACTER_SELECT[id];
        return { id, name: c.name, role: sel.role, color: sel.color, maxHp: c.stats.maxHp, speed: c.stats.speed, hitSize: c.stats.hitSize, locked: !isCharacterSelectable(id), selectable: isCharacterSelectable(id) };
      }),
      (id) => void this.selectCharacter(id as CharacterId),
    );
    this.hud.setCharacter(this.avatar.character.id, false);
    this.hud.setLoadoutOptions(PRIMARY_WEAPONS.map((w) => ({ id: w.id, name: w.name })), (id) => this.selectPrimary(id));
    this.hud.setLoadout(this.primary.id, false);

    // 사용자 설정 적용 + 메인 로비 (?net=1로 멀티 메뉴를 바로 열면 메뉴가 먼저 보임)
    this.audio.setMaster(this.userSettings.master);
    this.audio.setMuted(this.userSettings.muted >= 0.5);
    this.audio.setVolume(this.userSettings.volume);
    this.audio.setMusicVolume(this.userSettings.music);
    this.input.mouseSensitivity = this.userSettings.mouseSensitivity;
    this.lobby = new Lobby(this.container, this.lobbyHost());
    this.pauseMenu = new PauseMenu(this.container, this.pauseHost());
    // 로비 전용 공간 (경기장 위 하늘 놀이섬, 맵 키트 재사용)에서 시작. 매치·멀티 입장 때 공간을 치우고 원래 스폰 규칙으로 배치
    this.lobbySpace = new LobbySpace(this.scene, this.physics, this.map.lobbyKit ?? null);
    this.placeAtSpawn(this.lobbySpace.spawn);
    // 온라인 로비: 같은 로비 인스턴스 사람들 (판정·충돌 없는 표시 전용 캐릭터 + 닉네임)
    this.peers = new LobbyPeers({
      createAvatar: (id) => this.createLobbyAvatar(id),
      releaseAvatar: (a) => a.dispose(),
      weaponModel: (wid) => this.weaponModels.get(WEAPONS[wid] ?? RIFLE),
      camera: () => this.tpsCamera.camera,
      container: this.container,
      lowPower: () => this.input.touchMode,
    });
    this.hub = new LobbyHub(this.netClient, {
      onPeerJoin: (p) => this.peers?.add(p),
      onPeerLeave: (acc) => this.peers?.remove(acc),
      onPeerChange: (p) => this.peers?.change(p),
    });
    // 계정에 저장된 닉네임 불러오기 (다른 기기·지운 저장소에서도 같은 이름, 첫 설정 창은 저장된 이름이 없을 때만)
    void this.syncServerNick();
    // 개발자 콘솔 retention(): 서버가 관리자 계정인지 확인하고 집계만 돌려줌
    installRetentionConsole(async (view) => {
      if (!(await withTimeout(this.netClient.connect(), 10000))) throw new Error('connect');
      return withTimeout(this.netClient.call<RetentionResult>('retentionGet', [view]), 20000);
    });
    // 유료 캐릭터: 보유 = 서버 기록만. 받으면 저장해 둔 유료 캐릭터(이전 접속에서 장착)를 다시 적용
    setCharacterOwnership((id) => this.shop.owns(id));
    this.shop.onChange(() => this.applyOwnedSaved());
    this.shop.start();
    void this.shop.syncOwned();

    // 첫 프레임 이전에 물리 쿼리 구조를 만들어 둔다
    this.physics.step();
    this.resize();
    this.resizeObserver.observe(this.container);
    this.timer.connect(document);
    this.loop();
  }

  private readonly loop = (time?: number): void => {
    this.rafId = requestAnimationFrame(this.loop);
    this.timer.update(time);
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.update(dt);
    this.drawWeaponPreviews();
    // 결과 화면: 경기장 대신 결과 무대만 (경기장 장면은 그리지 않음)
    const result = this.resultScreen;
    if (result?.stageOn) {
      result.update(dt);
      result.stage.render(this.renderer);
    } else this.renderer.render(this.scene, this.tpsCamera.camera);
  };

  /** 정비소 실시간 무기 미리보기: 각도·무기가 바뀐 미리보기만 이번 프레임에 한 번 그림 (메인 장면 직전, 같은 렌더러) */
  private drawWeaponPreviews(): void {
    for (const p of this.weaponPreviews) {
      if (!p.canvas.isConnected) {
        this.weaponPreviews.delete(p);
        continue;
      }
      if (!p.dirty || !p.id) continue;
      p.dirty = false;
      const bg = getComputedStyle(p.canvas).getPropertyValue('--lb-preview-bg').trim() || '#fff4e4';
      this.weaponArt.drawLive(p.id, p.yaw, p.canvas, bg);
    }
  }

  private update(dt: number): void {
    this.input.beginFrame();
    const input = this.input.state;
    this.updateFps(dt);
    this.updateLobbyVisibility();
    this.syncPauseMenu();

    // 무기 장착 디버그 패널은 개발 모드에서만
    if (input.debugTogglePressed && import.meta.env.DEV) {
      if (this.debugPanel.toggle()) this.input.releaseLock();
    }

    // --- 시점 (렌더 프레임마다 즉시 반영) --- 모바일 터치 회전분에만 약한 에임 보정 (카메라 입력만, 판정 무관)
    this.applyTouchAimAssist();
    this.tpsCamera.applyLook(input.lookDX, input.lookDY, this.aim.lookSensitivityMultiplier);

    // --- 매치 진행 (카운트다운·타이머·시간 종료) ---
    // 연습전 일시정지: 타이머·봇 정지 (멀티는 서버 시각으로 계속 진행 — 내 입력만 막힘, 무적 없음)
    const practicePaused = !this.netGame && !!this.pauseMenu?.visible;
    if (!practicePaused) this.match.update(dt);
    const combatActive = this.match.combatActive;
    // 대기·카운트다운·종료 중에는 봇도 제자리 (종료 후에는 쓰러진 봇도 부활하지 않음)
    this.bots.hold = !combatActive || practicePaused;
    this.bots.respawnEnabled = this.match.respawnAllowed;
    // 원격 플레이어: 보간 위치·자세·판정을 물리 스텝 전에 맞춤 (이번 프레임 사격 판정에 반영)
    this.net?.updateRemotes(dt);

    // --- 사망/리스폰 ---
    this.combatant.update(dt);
    // K = 사망 테스트 (개발 키, 배포 빌드에서는 무시)
    if (import.meta.env.DEV && input.suicidePressed && !this.dead && combatActive) this.kill(null, null, 'suicide');
    if (this.dead && this.match.respawnAllowed) {
      this.deathTimer -= dt;
      if (this.deathTimer <= 0) {
        if (this.net?.session.inRoom) this.requestNetRespawn();
        else this.respawn();
      }
    }
    if (this.lobbySpace?.isBelow(this.player.position.y) && this.inLobby) {
      // 로비: 사망·킬로그·기록 없이 시작 위치로 (울타리가 막아 보통은 일어나지 않음)
      this.placeAtSpawn(this.lobbySpace.spawn);
    } else if (this.player.position.y < MOVEMENT.killPlaneY) {
      // 낙사: 공격자 없는 사망으로 집계 (데스만) 후 바로 부활
      if (!this.dead) {
        this.match.recordDeath(this.combatant.id, null);
        this.reportDeath(this.combatant.id, null, null, 'fall');
        // 네트워크: 서버에 낙사(바로 부활 가능) → 리스폰 승인 (일반 호출은 보낸 순서대로 실행)
        this.net?.selfDeath('fall');
        if (this.net?.session.inRoom) {
          // 서버 승인 전에 로컬로 먼저 부활 → 응답이 올 때까지는 로컬 보호(2초)를 그대로 두고, 응답의 보호 끝 시각으로 맞춤
          this.netProtAwait = true;
          void this.net.requestRespawn().then((r) => {
            this.netProtAwait = false;
            if (r.prot !== undefined) this.netProtEnd = r.prot;
            this.syncNetProtection(true);
          });
        }
      }
      this.respawn();
    }

    // 이동·사격·무기 교체는 전투 중(PLAYING)에만
    const canAct = !this.dead && this.input.isLocked && combatActive && !this.lobbyShown;
    // 로비 자유 이동: 이동·달리기·점프·슬라이딩만 (TAB 메뉴가 열리면 멈춤). 사격·ADS·무기 교체·피해 없음
    // 로비 자유 이동: 커서가 보이는 채로 이동 키·조이스틱만 (포인터 잠금 없음). 메뉴 창이 열리면 멈춤
    const roaming = this.lobbyShown && !this.lobbyMenuOpen && !this.dead;
    const canMove = canAct || roaming;
    // --- 무기 교체: 숫자키 1·2·3, 휠은 세 슬롯 순환 ---
    if (canAct && input.slotPressed > 0) this.switchSlot(input.slotPressed - 1);
    if (canAct && input.wheelSteps !== 0) {
      const n = this.loadout.length;
      this.switchSlot((((this.slotIndex + input.wheelSteps) % n) + n) % n);
    }

    // --- 이동 (고정 스텝) ---
    // 달리기 의도: PC는 입력(W 더블 탭)이 정함, 모바일은 조이스틱 전방 유지 시간으로 판정. 이후 이동·애니메이션·ADS 해제는 같은 경로
    const sprintIntent =
      canMove && (input.moveSource === 'joystick' ? this.autoSprint.update(dt, input.moveX, input.moveY, this.player.isSliding) : input.sprint);
    if (!canMove) this.autoSprint.reset();
    if (canMove && input.jumpPressed) this.player.queueJump();
    if (canMove && input.slidePressed) this.player.queueSlide();
    const step = RENDER.fixedStep;
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= step && steps < RENDER.maxSubSteps) {
      this.player.step(step, {
        moveX: canMove ? input.moveX : 0,
        moveY: canMove ? input.moveY : 0,
        // 로비: 고정 구도 카메라 기준 (W = 화면 안쪽)
        cameraYaw: this.lobbyShown ? this.lobbyCamYaw : this.tpsCamera.yaw,
        // ADS 중에도 달리기 입력을 받는다 → 달리기가 시작되면 AimController가 ADS를 해제
        sprint: sprintIntent,
        // 무기별 이동속도(권총·근접 1.2배) × ADS 감속. 현재 무기 값으로 매 스텝 새로 곱함 (누적 없음)
        speedMultiplier: this.aim.moveSpeedMultiplier * this.weapons.def.moveSpeedMultiplier,
      });
      this.bots.fixedStep(step);
      this.physics.step();
      this.accumulator -= step;
      steps++;
    }
    if (steps === RENDER.maxSubSteps) this.accumulator = 0;
    const alpha = this.accumulator / step;
    this.renderFeet.lerpVectors(this.player.prevPosition, this.player.position, alpha);
    this.renderFeet.y -= this.player.footOffset;

    // --- ADS 상태 (이동 결과 반영 후 해제/진입 판정, 카메라는 블렌드로 따라감) ---
    const p = this.player;
    this.aim.updateActions({
      sprinting: p.sprinting && p.grounded && !p.isSliding,
      // 점프는 즉시, 발을 헛디딘 낙하는 잠깐(0.15s) 지나야 공중으로 판정
      airborne: p.mode === 'air' && (p.velocity.y > 0 || p.airTime > 0.15),
      sliding: p.isSliding,
      reloading: this.weapons.weapon.reloading,
    });
    const touchAim = this.input.touchMode ? this.input.touch.aimRequest : null;
    if (touchAim !== null && (!touchAim || (canAct && this.weapons.ready))) {
      if (this.weapons.reaimPending) this.weapons.cancelReaim();
      this.aim.set(touchAim);
    } else if (canAct && input.aimTogglePressed && this.weapons.ready) {
      // 볼트액션 중 자동 재조준이 예약돼 있으면 우클릭 = 예약 취소 (조준하지 않음). 아니면 기존 토글
      if (this.weapons.reaimPending) this.weapons.cancelReaim();
      else this.aim.toggle();
    }
    this.aim.update(dt);

    // --- 몸 방향 ---
    const vel = this.player.velocity;
    const speed = Math.hypot(vel.x, vel.z);
    // 로비에서는 클릭해도 전투 자세를 잡지 않음 (사격 없음)
    const combatFacing = !this.dead && (this.aim.isAiming || this.weapons.timeSinceShot < 0.7 || (input.fireHeld && !this.lobbyShown));
    // 총기 전투 자세(조준·사격 중): 총이 보이게 몸을 조준 방향보다 오른쪽으로 비틂 (기존). 근접무기는 비틀지 않음
    const bodyCombatFacing = combatFacing && !this.weapons.isMelee;
    // 몸(루트) 방향 = 카메라 수평 회전(yaw)만. 피치는 루트에 넣지 않음 (상체 숙임은 applySpinePitch, 전투 중만).
    // 이동 방향을 보려고 따로 돌지 않음 → WASD는 카메라 기준 그대로, 다리는 골반 비틀기·뒤로 걷기로 이동 방향 표현.
    // 카메라는 몸 방향을 읽지 않아(발 위치만 따라감) 회전 피드백 루프 없음.
    const strafing = !this.player.isSliding;
    let targetYaw = this.tpsCamera.yaw + Math.PI;
    // 로비(고정 카메라): 움직이는 방향을 바라봄, 멈추면 그대로
    if (this.lobbyShown) targetYaw = speed > 0.4 ? Math.atan2(vel.x, vel.z) : this.bodyYaw;
    else if (this.player.isSliding && speed > 0.5) targetYaw = Math.atan2(vel.x, vel.z);
    else if (bodyCombatFacing)
      // ADS(캐릭터 숨김) 중에는 비틀기를 풀어 총구를 중앙 쪽으로 (좌우 엄폐 차이 감소)
      targetYaw -= THREE.MathUtils.degToRad(
        CHARACTER.anim.combatYawOffsetDeg * (1 - this.aim.blend) + (this.aim.visualProfile?.adsBodyYawDeg ?? 0) * this.aim.blend,
      );
    if (!this.dead) this.bodyYaw = dampAngle(this.bodyYaw, targetYaw, MOVEMENT.aimTurnSharpness, dt);
    this.netPitch = bodyCombatFacing ? this.tpsCamera.pitch : 0;
    this.netStrafing = strafing;
    // 제자리 회전: 서 있을 때 다리는 남기고 골반만 비틂 (PlayerAvatar)
    const turnInPlace = !this.dead && this.player.grounded && !this.player.isSliding && speed < 0.3;

    // --- 카메라 ---
    // 터치 모드면 모바일 일반 시점 (PC 마우스 모드는 그대로)
    this.tpsCamera.mobile = this.input.touchMode;
    this.tpsCamera.update({
      dt,
      target: this.renderFeet,
      aimBlend: this.aim.blend,
      // 화면용 프로필: ADS 중 무기를 바꿔도 이전 무기의 ADS 위치에서 부드럽게 복귀
      aimProfile: this.aim.visualProfile,
      slideBlend: this.avatar.slideBlend,
      sprinting: sprintIntent && speed > MOVEMENT.walkSpeed + 0.5,
    });
    const cam = this.tpsCamera.camera;

    // --- 총 방향: 전투 중엔 크로스헤어 조준점, 평소엔 몸 정면 (근접무기는 항상 몸 정면 → 휘두르기가 캐릭터 로컬 기준) ---
    const aimProfile = this.aim.currentProfile;
    const adsBlend = this.aim.blend;
    const chest = this.avatar.getChestPosition(_v1);
    const desiredDir = _v2;
    if (bodyCombatFacing || adsBlend > 0.01) {
      const aimPoint = this.computeAimPoint(cam, chest);
      desiredDir.subVectors(aimPoint, chest).normalize();
      this.aimDir.lerp(desiredDir, 1 - Math.exp(-22 * dt)).normalize();
      if (adsBlend > 0) {
        // ADS: 총구가 화면 중앙 조준점을 정확히 향하도록 (지연 없이)
        const muzzleDir = _v3.copy(aimPoint).sub(this.lastMuzzle);
        if (muzzleDir.lengthSq() > 1e-6) this.aimDir.lerp(muzzleDir.normalize(), adsBlend).normalize();
      }
    } else {
      desiredDir.set(Math.sin(this.bodyYaw), 0, Math.cos(this.bodyYaw));
      this.aimDir.lerp(desiredDir, 1 - Math.exp(-22 * dt)).normalize();
    }

    // --- 캐릭터 포즈 ---
    this.avatar.update({
      dt: this.freezeAnim ? 0 : dt,
      feet: this.renderFeet,
      bodyYaw: this.bodyYaw,
      aimDir: this.aimDir,
      pitch: bodyCombatFacing ? this.tpsCamera.pitch : 0,
      mode: this.player.mode,
      grounded: this.player.grounded,
      sprinting: this.player.sprinting && this.player.grounded,
      velocity: vel,
      justJumped: this.player.justJumped,
      justLanded: this.player.justLanded,
      landedAirTime: this.player.landedAirTime,
      dead: this.dead,
      strafing,
      turnInPlace,
      adsBlend: this.aim.blend,
      // ADS 중에는 총 밀림을 줄여 무기 흔들림을 억제
      weaponKick: this.weapons.kick * (aimProfile ? THREE.MathUtils.lerp(1, aimProfile.kickScale, adsBlend) : 1),
      weaponRaise: this.weapons.raise,
      reloadProgress: this.weapons.reloadProgress,
      meleeSwing: this.weapons.swingProgress,
      boltProgress: this.weapons.boltProgress,
    });
    // 원형 스코프 화면은 scopeOverlay(스나이퍼)만. ADS가 꺼지면(발사 후 볼트액션·재장전·교체) 블렌드를 기다리지 않고 즉시 닫음
    const scopeOverlay =
      aimProfile?.style === 'scopeOverlay' && this.aim.isAiming
        ? THREE.MathUtils.clamp((adsBlend - aimProfile.overlayFrom) / (1 - aimProfile.overlayFrom), 0, 1)
        : 0;

    if (this.lobbyShown) this.updateLobbyFollowCamera(cam, dt);
    this.updateShowcase(cam, dt);
    if (this.poseView.on) {
      const pv = this.poseView;
      const d = THREE.MathUtils.degToRad;
      this.inspectOrbit = { yaw: this.bodyYaw + d(pv.angleDeg), pitch: d(pv.pitchDeg), distance: pv.distance, height: 0.1 };
    }
    if (this.inspectOrbit) {
      const o = this.inspectOrbit;
      const c = o.focusRifle ? this.avatar.rifle.getWorldPosition(new THREE.Vector3()) : this.avatar.getChestPosition(new THREE.Vector3());
      c.y += o.height ?? 0;
      cam.position.set(
        c.x + Math.sin(o.yaw) * Math.cos(o.pitch) * o.distance,
        c.y + Math.sin(o.pitch) * o.distance,
        c.z + Math.cos(o.yaw) * Math.cos(o.pitch) * o.distance,
      );
      cam.lookAt(c);
      cam.updateMatrixWorld();
    }
    // --- 로컬 플레이어 가림 (카메라 최종 위치 기준) ---
    this.occlusion.update({ dt, camera: cam, adsActive: this.aim.isAiming, aimProfile: this.aim.visualProfile, hideWeapon: scopeOverlay > 0 });

    // 판정 영역을 이번 포즈에 맞춤 (봇이 쏘는 대상)
    if (!this.dead) this.combatant.hitboxes.update(this.avatar, this.renderFeet, this.player.footOffset);

    // --- 사격 ---
    const muzzle = this.muzzle;
    this.avatar.getMuzzle(muzzle, this.muzzleDir);
    this.muzzleDebug?.update(dt, muzzle, this.muzzleDir);
    const weaponFrame = {
      dt,
      triggerHeld: input.fireHeld,
      automaticTrigger: this.input.touchMode && this.input.touch.automaticFire,
      reloadPressed: input.reloadPressed,
      canAct,
      camera: cam,
      pivot: _v3.copy(chest),
      muzzle,
      chest: _v4.copy(chest),
      moving: speed > 0.5,
      airborne: !this.player.grounded,
      sliding: this.player.isSliding,
      bodyForward: this.bodyForward.set(Math.sin(this.bodyYaw), 0, Math.cos(this.bodyYaw)),
    };
    this.weapons.update(weaponFrame);
    // 조준점은 비어 있는데 총구 쪽 장애물에 막히면 실제 탄착 지점을 HUD에 표시
    const prediction = this.weapons.predict(weaponFrame);
    this.shotDebug?.update(dt, this.weapons.isMelee ? null : prediction.shot);
    this.lastMuzzle.copy(muzzle);
    for (const t of this.targets) t.update(dt);
    // --- 봇 (감지·결정은 간격, 애니메이션·조준은 매 프레임) ---
    this.bots.update(dt, alpha, cam);
    this.updateSpawnFx();
    this.characterDebug?.update(dt, this.debugPanel.visible);
    this.bullets.update(dt);
    this.tracers.update(dt);
    this.effects.update(dt);
    this.map.followShadow(this.renderFeet);
    this.map.update?.(dt);

    // --- HUD ---
    const w = this.weapons.weapon;
    const spreadRad = THREE.MathUtils.degToRad(this.weapons.lastSpreadDeg);
    const spreadPx = (Math.tan(spreadRad) / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) * (this.container.clientHeight / 2);
    // 디버그 정보는 개발 모드에서만
    const debugLines = import.meta.env.DEV
      ? [
          `mode ${this.player.mode}  grounded ${this.player.grounded}  speed ${speed.toFixed(2)} m/s`,
          `ADS ${this.aim.isAiming ? 'ON' : 'off'} (${this.aim.blend.toFixed(2)})  fov ${cam.fov.toFixed(1)}  spread ${this.weapons.lastSpreadDeg.toFixed(2)}°`,
          `IK 미도달 R ${(this.avatar.reachError.right * 100).toFixed(1)}cm  L ${(this.avatar.reachError.left * 100).toFixed(1)}cm`,
          ...this.aimDebugLines(prediction),
          `HP ${this.combatant.health.hp.toFixed(0)}  보호 ${this.combatant.health.protection.toFixed(1)}s${this.combatant.invincible ? '  [무적]' : ''}`,
          `무기 ${w.def.id}  탄 ${w.magazine}/${w.reserve}${w.reloading ? ` 재장전 ${(w.reloadProgress * 100).toFixed(0)}%` : ''}  ADS ${this.aim.isAiming ? 'ON' : 'off'}${this.weapons.reaimPending ? '  (볼트 후 자동 재조준 예약)' : ''}`,
          ...this.quickSwapDebugLines(),
          ...this.bots.debugLines(),
        ]
      : [];
    this.hud.update(
      {
        dt,
        fps: this.fps,
        magazine: w.magazine,
        magazineSize: w.def.magazineSize,
        reserve: w.reserve,
        reloadProgress: w.reloadProgress,
        reloading: w.reloading,
        aiming: this.aim.isAiming,
        aimBlend: this.aim.blend,
        spreadPx,
        weaponId: w.def.id,
        crosshair: w.def.crosshair,
        scopeOverlay,
        blockedAt: !this.dead && (combatFacing || this.aim.isAiming) && prediction.blocked ? prediction.impact : null,
        enemyTargeted: !this.dead && prediction.enemy !== null,
        dead: this.dead,
        respawnIn: Math.max(0, this.deathTimer),
        killedBy: this.killedBy,
        match: this.matchHud(),
        hp: this.combatant.health.hp,
        maxHp: this.combatant.health.maxHp,
        protection: this.combatant.health.protection,
        cameraYaw: this.tpsCamera.yaw,
        playerPos: this.renderFeet,
        weaponName: w.def.name,
        melee: this.weapons.isMelee,
        slots: this.loadout.map((d, i) => ({ key: String(i + 1), id: d.id, name: d.name, active: i === this.slotIndex })),
        botLabels: this.net ? [...this.bots.labels, ...this.net.labels] : this.bots.labels,
        // 개발용 수치는 개발 서버에서 디버그 패널(`)을 열었을 때만 (일반 플레이 화면에는 정식 HUD만)
        debug: import.meta.env.DEV && this.debugPanel.visible,
        debugLines,
      },
      cam,
      this.container.clientWidth,
      this.container.clientHeight,
    );
    this.debugPanel.setStatus(debugLines.join('\n'));
    // 터치 버튼 상태 표시 (재장전 중·ADS 켜짐·근접무기)
    if (this.input.touch.active) {
      this.input.touch.setReloading(w.reloading);
      this.input.touch.setAiming(this.aim.isAiming);
      this.input.touch.setMelee(this.weapons.isMelee);
    }
    // 네트워크 전송은 이번 프레임 최종 상태로 (50ms마다)
    this.net?.update(dt, this.player.justJumped, this.player.justLanded);
    this.updateHub(dt);
    this.netPanel?.update(dt);
    // 멀티 측정 패널: F9 네트워크 디버그를 열었을 때만 (정식 HUD와 겹치지 않게)
    this.netHud?.update(dt, this.netGame && !!this.netPanel?.isOpen);
    this.updateSounds();
    this.updateScoreboard();
    this.updateCoach(dt);
    this.mpRefreshTimer -= dt;
    if (this.mpRefreshTimer <= 0 && this.mpMenu) {
      this.mpRefreshTimer = 0.25;
      this.refreshMultiplayerMenu();
    }
    this.input.endFrame();
  }

  /**
   * 화면 중앙 조준점 (실제 사격과 같은 카메라 중앙 레이, 캐릭터 옆에서 시작).
   * 총 방향 계산용이라 너무 가까운 점은 최소 거리로 밀어 총이 과하게 꺾이지 않게 한다.
   */
  private computeAimPoint(cam: THREE.PerspectiveCamera, chest: THREE.Vector3): THREE.Vector3 {
    const dir = cam.getWorldDirection(_v3);
    const alongView = Math.max(0, _v4.subVectors(chest, cam.position).dot(dir));
    const origin = _v4.copy(cam.position).addScaledVector(dir, alongView);
    const hit = this.physics.raycast(origin, dir, 200, undefined, this.player.body);
    const dist = hit ? Math.max(hit.distance, 2.0) : 200;
    return origin.addScaledVector(dir, dist);
  }

  /** 조준 판정 디버그: 조준 대상, 카메라 레이 충돌 지점, 총구 막힘, 빨간 조준선 이유 */
  private aimDebugLines(p: ShotPrediction): string[] {
    const ch = p.cameraHit;
    const camTarget = ch ? (ch.hitbox ? `${ch.hitbox.target.name ?? 'target'}/${ch.hitbox.part}` : '장애물') : '없음';
    const point = ch ? `(${ch.point.x.toFixed(2)}, ${ch.point.y.toFixed(2)}, ${ch.point.z.toFixed(2)}) ${ch.distance.toFixed(1)}m` : '-';
    const reason = p.enemy
      ? `빨강: 총구→조준점 경로가 ${p.enemy.name}/${p.enemy.part}에 맞음`
      : ch?.hitbox && p.blocked
        ? '노랑: 카메라엔 적이 보이지만 총구 경로가 장애물에 막힘'
        : ch?.hitbox
          ? '노랑: 적이 쓰러진 상태'
          : '노랑: 조준점에 적 없음';
    const st = p.shot.stage;
    const stopAt = p.shot.hit ? this.physics.labelOf(p.shot.hit.collider) : '없음';
    const stage = st === 'clear' ? '조준점까지 열림' : st === 'muzzle' ? `총구가 장애물 안·뒤 (${stopAt})` : `총구→조준점 막힘 (${stopAt}, 총구에서 ${p.shot.from.distanceTo(p.shot.end).toFixed(2)}m)`;
    return [
      `조준 대상(카메라) ${camTarget}  지점 ${point}`,
      `총구 막힘 ${p.blocked ? 'O' : 'X'}  ${reason}`,
      `탄 경로: ${stage}  총구 (${p.shot.from.x.toFixed(2)}, ${p.shot.from.y.toFixed(2)}, ${p.shot.from.z.toFixed(2)})`,
    ];
  }

  /**
   * 탄 1발 결과 연출 (플레이어·봇 공용): 장난감 탄환이 총구 → 실제 탄착 지점까지 날아가고, 도착하면 탄착(벽/캐릭터) 효과.
   * 판정·피해는 이미 발사 순간 끝남 (히트스캔) — 히트마커·피해 숫자·명중음(presentVolley)도 그대로 즉시.
   * 플레이어 피격 표시는 onPlayerDamaged.
   */
  private presentShot(r: ShotResult): void {
    const hit = r.hit;
    this.presentShotFx(
      r.weapon?.id,
      r.from,
      r.end,
      hit ? (hit.hitbox ? 'character' : 'world') : 'none',
      hit ? hit.normal.clone() : null,
      r.attacker?.id,
      r.headshot,
      r.killed,
      hit ? hit.point.clone() : null,
    );
  }

  /**
   * 탄 1발 연출 공통 (로컬 판정 결과·네트워크 원격 탄): 탄환 비행 → 도착하면 캐릭터 명중 POP / 벽 방울·링.
   * point = 탄착 지점 (없으면 end)
   */
  private presentShotFx(
    weaponId: string | undefined,
    from: THREE.Vector3,
    end: THREE.Vector3,
    kind: 'none' | 'character' | 'world',
    normal: THREE.Vector3 | null,
    shooterId: string | undefined,
    headshot: boolean,
    killed: boolean,
    point: THREE.Vector3 | null = null,
  ): void {
    const byPlayer = shooterId === this.combatant.id;
    const color = this.bulletColor(shooterId);
    let arrive: (() => void) | null = null;
    if (kind !== 'none') {
      const at = (point ?? end).clone();
      const n = normal ?? new THREE.Vector3().subVectors(from, end).normalize();
      const vfx = BULLET_VFX[bulletVfxIdOf(weaponId)];
      arrive =
        kind === 'character'
          ? () => {
              // 캐릭터 명중: 탄환 색 고무 방울이 맞은 면 쪽으로 팡 터짐 (+ 링·별 POP). 헤드샷은 조금 크고 많게 + 노란 별
              const hs = headshot ? VFX_HEADSHOT : { dropletMul: 1, scaleMul: 1 };
              this.bullets.burst(at, n, color, vfx.hitDroplets * hs.dropletMul, 0.065 * vfx.hitScale * hs.scaleMul, 3.2 * vfx.hitScale, 0.9, 0.36);
              this.effects.enemyHit(at, n, headshot, killed, color, vfx.hitScale);
            }
          : () => {
              // 벽·바닥: 납작하게 퍼지는 방울 + 작은 방울 튐 + 링 (흔적은 0.2초 뒤 자동으로 사라짐, 칠하기 없음)
              this.bullets.splat(at, n, color, vfx.diameter * 1.6 * vfx.impactScale);
              this.bullets.burst(at, n, color, vfx.impactDroplets, 0.035 * vfx.impactScale, 2.2, 0.8, 0.3);
              this.effects.toyImpact(at, n, color, vfx.impactScale);
              this.audio.play('impact', byPlayer ? { pos: at } : { pos: at, gain: MIX.otherGain, channel: 'otherImpact' });
            };
    }
    this.bullets.fire(weaponId, from, end, arrive, color);
    // 발광 궤적 (총구 → 실제 탄착, 엄폐물에 막히면 그 지점) — 내 탄·봇·원격 플레이어 모두 같은 길
    this.tracers.add(weaponId, from, point ?? end, color);
  }

  /**
   * 플레이어 방아쇠 1회의 HUD 연출: 펠릿 여러 발이 맞아도 히트마커·명중음은 한 번,
   * 피해 숫자는 대상별 합계 하나 (샷건 8펠릿이 숫자 8개로 흩어지지 않게).
   */
  private presentVolley(shots: readonly ShotResult[]): void {
    let any = false;
    let head = false;
    let killed = false;
    const perTarget = new Map<Damageable, { total: number; head: boolean; point: THREE.Vector3 }>();
    for (const r of shots) {
      const t = r.hit?.hitbox?.target;
      if (!t || r.damage <= 0) continue;
      // 멀티 원격 플레이어: 피해는 서버가 확정 → 표시는 confirmedHit에서 (여기는 예측이라 건너뜀)
      if (isRemoteTarget(t)) continue;
      any = true;
      head ||= r.headshot;
      killed ||= r.killed;
      const e = perTarget.get(t);
      if (e) {
        e.total += r.damage;
        e.head ||= r.headshot;
      } else {
        perTarget.set(t, { total: r.damage, head: r.headshot, point: r.hit!.point });
      }
    }
    if (!any) return;
    for (const e of perTarget.values()) this.hud.damagePopup(e.point, e.total, e.head);
    this.hitFeedback(head, killed);
  }

  /**
   * 확정된 명중 피드백 (히트마커 + 소리, 글자 없음): 일반·헤드샷 = 같은 명중음, 처치 = 처치음만
   * (명중음과 겹치지 않게). 로비에서는 없음
   */
  private hitFeedback(headshot: boolean, killed: boolean): void {
    if (this.lobbyShown) return;
    this.hud.showHit(headshot, killed);
    // 헤드샷 전용 소리 없음: 명중은 모두 같은 소리, 처치만 다른 소리
    this.audio.play(killed ? 'kill' : 'hit');
  }

  /** 근접 판정 결과 연출 (헤드샷 표시 없음) */
  private presentMelee(r: MeleeResult): void {
    let killed = false;
    let local = 0;
    for (const h of r.hits) {
      this.effects.enemyHit(h.point, h.normal, false, h.killed);
      // 멀티 원격 플레이어는 서버 확정 때 표시 (confirmedHit)
      if (isRemoteTarget(h.target)) continue;
      local++;
      this.hud.damagePopup(h.point, h.damage, false);
      killed ||= h.killed;
    }
    if (r.hits.length > 0) this.audio.play('meleeHit');
    if (local > 0) this.hitFeedback(false, killed);
    else if (r.hits.length === 0 && r.wall) {
      this.effects.worldImpact(r.wall.point, r.wall.normal);
      this.audio.play('meleeHit', { gain: 0.6 });
    }
  }

  /** 1번 주무기 / 2번 권총 / 3번 근접 */
  private get loadout(): WeaponDef[] {
    return [this.primary, SECONDARY_WEAPON, MELEE_WEAPON];
  }

  /**
   * 슬롯 교체: 이전 무기 재장전 취소·ADS 해제·교체 시간(사격 불가)은 WeaponSystem.equip이 처리.
   * 손 모델·장착값은 즉시 바꾸고 무기를 드는 연출(raise)로 보여 준다.
   */
  private switchSlot(index: number, force = false): void {
    const def = this.loadout[index];
    if (!def || (index === this.slotIndex && !force)) return;
    if (!force) this.audio.play('weaponSwitch');
    this.slotIndex = index;
    this.input.touch.setWeapon(def.id);
    // beginFrame에서 이미 복사된 터치 방아쇠도 같은 프레임에 비워 새 무기가 발사되지 않게 한다. PC 입력은 유지한다.
    if (this.input.touchMode) this.input.state.fireHeld = false;
    this.weapons.equip(def);
    this.avatar.setWeapon(this.weaponModels.get(def), def.mount);
  }

  /**
   * 확정된 사망 1건 → 킬로그 (HUD 표시만, 점수·전투 로직과 무관). 부르는 곳은 실제 사망이 확정되는 지점뿐:
   * 봇 Bot.applyHit 사망(onDeath), 플레이어 kill(피격 사망·사망 테스트 키), 낙사.
   * 무기·헤드샷은 마지막 피해(HitInfo)에 실린 값 그대로 (무기 교체 후 판정이 나도 실제로 맞힌 무기)
   */
  private reportDeath(victimId: string, killer: AttackerInfo | null, hit: HitInfo | null, cause: DeathCause): void {
    if (this.feedDead.has(victimId)) return;
    this.feedDead.add(victimId);
    this.hud.pushKill(this.killEvent(victimId, killer?.id ?? null, hit?.weaponId ?? null, hit?.headshot === true, killer ? cause : cause === 'weapon' ? 'environment' : cause));
  }

  /** 킬로그 항목 만들기 (실제 사망·디버그 테스트 공용). 이름은 매치 참가자 이름, 색은 모드 규칙 */
  private killEvent(victimId: string, killerId: string | null, weaponId: string | null, headshot: boolean, cause: DeathCause, names?: { killer?: string; victim?: string }): KillFeedEvent {
    const name = (id: string) => this.match.stats.get(id)?.name ?? id;
    const team = (id: string) => (this.appearanceMode === 'TDM' ? this.teams.get(id) ?? 'NONE' : 'NONE');
    return {
      killerId,
      killerName: killerId ? names?.killer ?? name(killerId) : null,
      victimId,
      victimName: names?.victim ?? name(victimId),
      weaponId: cause === 'weapon' ? weaponId : null,
      headshot: cause === 'weapon' && headshot,
      cause,
      killerTeam: killerId ? team(killerId) : null,
      victimTeam: team(victimId),
      killerColor: killerId ? this.killFeedColor(killerId) : null,
      victimColor: this.killFeedColor(victimId),
      localKiller: killerId === this.combatant.id,
      localVictim: victimId === this.combatant.id,
      timestamp: performance.now(),
    };
  }

  /**
   * 개발용 킬로그 테스트 (개발 서버만). 킬로그 표시만 하고 매치 킬·데스·전적에는 넣지 않음.
   * 콘솔: __game.testKillFeed('rifle' | 'shotgun' | 'sniperHead' | 'pistol' | 'melee' | 'meKill' | 'botKillsMe' | 'botVsBot' | 'burst' | 'longName' | 'suicide' | 'fall')
   */
  testKillFeed(kind: string): boolean {
    if (!import.meta.env.DEV) return false;
    const me = this.combatant.id;
    const [b1, b2, b3] = this.bots.bots.map((b) => b.id) as [string, string, string];
    const push = (victim: string, killer: string | null, weapon: string | null, head = false, cause: DeathCause = 'weapon', names?: { killer?: string; victim?: string }) =>
      this.hud.pushKill(this.killEvent(victim, killer, weapon, head, cause, names));
    switch (kind) {
      case 'rifle': push(b2, b1, 'rifle'); break;
      case 'shotgun': push(b3, b2, 'shotgun'); break;
      case 'sniperHead': push(b1, me, 'sniper', true); break;
      case 'pistol': push(b2, me, 'pistol'); break;
      case 'melee': push(b3, me, 'melee'); break;
      case 'meKill': push(b1, me, 'rifle'); break;
      case 'botKillsMe': push(me, b3, 'rifle', true); break;
      case 'botVsBot': push(b1, b3, 'rifle'); break;
      case 'burst': {
        const order: Array<[string, string, string, boolean]> = [[b1, me, 'rifle', false], [b2, b3, 'shotgun', false], [me, b2, 'sniper', true], [b3, b1, 'pistol', false], [b2, me, 'melee', false], [b1, b2, 'rifle', true]];
        order.forEach(([v, k, w, h], i) => setTimeout(() => push(v, k, w, h), i * 120));
        break;
      }
      case 'longName': push(b1, me, 'rifle', false, 'weapon', { killer: '아주아주긴닉네임플레이어123', victim: 'SuperLongBotNickname_9999' }); break;
      case 'suicide': push(me, null, null, false, 'suicide'); break;
      case 'fall': push(b2, null, null, false, 'fall'); break;
      default: return false;
    }
    return true;
  }

  /**
   * 디버그 패널 TOY BULLET VFX: 무기별 시각 탄환 설정을 실시간 조절 (config/bulletVfx.ts 값 직접 수정, 새로고침하면 원래대로).
   * 데미지·사거리·명중 판정 설정(config/weapons.ts)과 별개. "값 복사"로 config에 붙여 넣기
   */
  private bulletVfxSection(): HTMLDetailsElement {
    const d = document.createElement('details');
    d.className = 'dp-section';
    const s = document.createElement('summary');
    s.textContent = 'TOY BULLET VFX (화면 표현만)';
    d.appendChild(s);
    let id: BulletVfxId = 'rifle';
    const select = document.createElement('select');
    select.className = 'dp-select';
    for (const k of Object.keys(BULLET_VFX)) select.add(new Option(k, k));
    const body = document.createElement('div');
    const fields: Array<[keyof BulletVfxProfile, string, number, number, number]> = [
      ['length', '길이(m)', 0.02, 0.4, 0.005],
      ['diameter', '지름(m)', 0.01, 0.2, 0.005],
      ['speed', '이동 속도(m/s)', 10, 250, 1],
      ['maxTravelTime', '최대 비행 시간(s)', 0.05, 1, 0.01],
      ['trailLength', '꼬리 길이(m)', 0, 1.5, 0.01],
      ['trailOpacity', '꼬리 불투명도', 0, 1, 0.01],
      ['impactScale', '벽 충돌 크기', 0.2, 3, 0.05],
      ['maxDistance', '최대 표시 거리(m)', 10, 250, 1],
      ['muzzleDroplets', '총구 방울 수', 0, 10, 1],
      ['muzzleScale', '총구 POP 크기', 0.2, 3, 0.05],
      ['hitDroplets', '명중 방울 수', 0, 20, 1],
      ['hitScale', '명중 POP 크기', 0.2, 3, 0.05],
      ['impactDroplets', '벽 방울 수', 0, 12, 1],
    ];
    const render = () => {
      body.textContent = '';
      const p = BULLET_VFX[id];
      for (const [key, label, min, max, step] of fields) {
        const row = document.createElement('div');
        row.className = 'dp-row';
        const input = document.createElement('input');
        input.type = 'range';
        Object.assign(input, { min: String(min), max: String(max), step: String(step), value: String(p[key]) });
        const num = document.createElement('input');
        num.type = 'number';
        num.step = String(step);
        num.value = String(p[key]);
        const apply = (v: number) => {
          if (!Number.isFinite(v)) return;
          (p as unknown as Record<string, number>)[key] = v;
          input.value = num.value = String(v);
        };
        input.oninput = () => apply(Number(input.value));
        num.onchange = () => apply(Number(num.value));
        row.append(Object.assign(document.createElement('span'), { textContent: label, title: label }), input, num);
        body.appendChild(row);
      }
      const copy = document.createElement('button');
      copy.textContent = '값 복사 (JSON)';
      copy.onclick = () => {
        const json = JSON.stringify(BULLET_VFX, null, 2);
        void navigator.clipboard?.writeText(json).catch(() => undefined);
        console.info('[BULLET_VFX]', json);
      };
      body.appendChild(copy);
    };
    select.onchange = () => {
      id = select.value as BulletVfxId;
      render();
    };
    const row = document.createElement('div');
    row.className = 'dp-row';
    row.append(Object.assign(document.createElement('span'), { textContent: '무기' }), select);
    d.append(row, body);
    render();
    return d;
  }

  /**
   * 탄환·POP 색 (시각 전용): TDM = 사수의 실제 팀 색, 그 밖에는 사수 캐릭터 대표색.
   * 캐릭터 RED와 팀 RED는 별개 → 팀은 teams(참가자 id) 기준으로만 판정
   */
  private bulletColor(shooterId: string | undefined): string {
    if (!shooterId) return BULLET_VFX.rifle.color;
    const team = this.appearanceMode === 'TDM' ? this.teams.get(shooterId) : undefined;
    if (team && team !== 'NONE') return BULLET_TEAM_COLORS[team];
    const avatar = this.avatarOf(shooterId);
    return avatar ? BULLET_CHARACTER_COLORS[avatar.character.id] : BULLET_VFX.rifle.color;
  }

  /** 총구 POP: 총구에서 탄환 색 방울이 앞쪽으로 톡 튀어나옴 (근접무기 제외) */
  private muzzlePop(muzzle: THREE.Vector3, dir: THREE.Vector3, weaponId: string, shooterId: string): void {
    if (!(weaponId in BULLET_VFX)) return;
    const vfx = BULLET_VFX[bulletVfxIdOf(weaponId)];
    const color = this.bulletColor(shooterId);
    this.bullets.burst(muzzle, dir, color, vfx.muzzleDroplets, 0.03 * vfx.muzzleScale, 2.4 * vfx.muzzleScale, 0.45, 0.16);
  }

  /** 개발용: 탄환 연출 품질 (모바일 기본 low). 콘솔 __game.setVfxQuality('high') */
  setVfxQuality(q: VfxQuality): VfxQuality {
    this.bullets.quality = q;
    this.tracers.low = q === 'low';
    return q;
  }

  /** 디버그 패널 KILL FEED TEST 섹션 */
  private killFeedTestSection(): HTMLDetailsElement {
    const d = document.createElement('details');
    d.className = 'dp-section';
    const s = document.createElement('summary');
    s.textContent = 'KILL FEED TEST (표시만, 점수 반영 없음)';
    d.appendChild(s);
    const grid = document.createElement('div');
    grid.className = 'dp-char-grid';
    const items: Array<[string, string]> = [
      ['rifle', '라이플'], ['shotgun', '샷건'], ['sniperHead', '스나이퍼 헤드샷'], ['pistol', '권총'], ['melee', '뿅망치'],
      ['meKill', '나 → 봇'], ['botKillsMe', '봇 → 나'], ['botVsBot', '봇 → 봇'], ['burst', '연속 6회'], ['longName', '긴 닉네임'],
      ['suicide', '자멸'], ['fall', '낙사'],
    ];
    for (const [kind, label] of items) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => this.testKillFeed(kind);
      grid.appendChild(b);
    }
    const tdm = document.createElement('button');
    tdm.textContent = 'TDM 팀 색 전환';
    tdm.onclick = () => this.setTeamPreview(this.appearanceMode !== 'TDM');
    grid.appendChild(tdm);
    d.appendChild(grid);
    return d;
  }

  /** 킬로그 이름 색: TDM = 소속 팀 색, 개인전(또는 팀 없음) = 캐릭터 고유 색 */
  private killFeedColor(id: string): string {
    const t = this.appearanceMode === 'TDM' ? this.teams.get(id) : undefined;
    if (t && t !== 'NONE') return KILL_FEED_TEAM_COLORS[t];
    const avatar = this.avatarOf(id);
    return avatar ? KILL_FEED_COLORS[avatar.character.id] : '#ffffff';
  }

  /** 참가자 아바타 (플레이어·봇·네트워크 원격) */
  private avatarOf(id: string): PlayerAvatar | undefined {
    if (id === this.combatant.id) return this.avatar;
    return this.bots.bots.find((b) => b.id === id)?.avatar ?? this.net?.avatarOf(id);
  }

  /** 플레이어 캐릭터 능력치·크기를 이동·카메라에 적용 (체력은 PlayerCombatant / setCharacter) */
  private applyPlayerCharacterStats(): void {
    this.player.speedScale = this.avatar.character.stats.speed;
    this.tpsCamera.heightScale = this.avatar.sizeRatio;
  }

  private loadCharacter(id: CharacterId): Promise<LoadedModel> {
    let p = this.characterModels.get(id);
    if (!p) {
      p = loadCharacterModel(this.renderer, id);
      // 실패하면 캐시하지 않음 (다시 시도 가능)
      p.catch(() => this.characterModels.delete(id));
      this.characterModels.set(id, p);
    }
    return p;
  }

  /**
   * 개발용 캐릭터 교체 (CHARACTER DEBUG, 콘솔 __game.setCharacter('player', 'black')). 개발 서버에서만.
   * GLB·능력치(최대 체력·이동 속도)·크기·판정(머리·몸통 실측)·무기 장착 보정·팀 외형을 함께 바꾼다.
   * 이전 아바타는 해제(애니메이션 정지·캐시 해제, 머티리얼 해제, 장면 제거), 가림 처리·외형 패치도 새로 만듦.
   * 체력은 새 최대 체력으로 가득. 매치 기록·무기·탄약·AI는 그대로
   */
  async setCharacter(who: string, id: CharacterId): Promise<boolean> {
    if (!import.meta.env.DEV) return false;
    return this.swapCharacter(who, id);
  }

  /**
   * 시작 화면 캐릭터 선택: 게임 시작 전에만, 이 빌드에서 고를 수 있는 캐릭터만 (잠긴 BLACK·WHITE는 배포 빌드에서 불가).
   * 고른 캐릭터는 브라우저에 저장 → 다음 접속 때 그 캐릭터로 시작. 봇 캐릭터는 바뀌지 않음
   */
  async selectCharacter(id: CharacterId): Promise<boolean> {
    if (this.combatant.active || this.netGame || !(id in CHARACTERS) || !isCharacterSelectable(id)) return false;
    if (id === this.avatar.character.id) return true;
    const token = ++this.characterSelectToken;
    this.hud.setCharacter(id, false, true);
    let ok = false;
    try {
      ok = await this.swapCharacter(this.combatant.id, id);
    } catch (err) {
      console.error('[character] 캐릭터 불러오기 실패', err);
    }
    // 불러오는 사이 다른 캐릭터를 눌렀으면 마지막 선택만 화면에 반영
    if (token !== this.characterSelectToken) return ok;
    if (ok) {
      saveCharacter(id);
      // 온라인 로비의 다른 사람 화면에도 새 캐릭터로
      this.hub?.setInfo({ char: id });
    }
    this.hud.setCharacter(this.avatar.character.id, this.combatant.active);
    return ok;
  }

  /** 캐릭터 교체 공통 (개발용 setCharacter, 시작 화면 selectCharacter) */
  private async swapCharacter(who: string, id: CharacterId): Promise<boolean> {
    if (!(id in CHARACTERS)) return false;
    const [model, mask, deadEyes] = await Promise.all([this.loadCharacter(id), loadTeamMask(CHARACTERS[id]), this.loadDeadEyesSafe(id)]);
    let avatar: PlayerAvatar;
    if (who === this.combatant.id) {
      const old = this.avatar;
      const markers = old.showMarkers;
      const weapon = old.rifle;
      const mount = old.mount;
      this.occlusion.dispose();
      old.dispose();
      avatar = new PlayerAvatar(SkeletonUtils.clone(model.scene), model.clips, weapon, mount, id);
      avatar.showMarkers = markers;
      this.avatar = avatar;
      this.scene.add(avatar.root);
      this.occlusion = new LocalPlayerOcclusion(avatar);
      this.combatant.health.setMaxHp(avatar.character.stats.maxHp);
      this.applyPlayerCharacterStats();
      // 개발용 교체도 시작 화면 카드 선택 표시를 맞춤
      this.hud.setCharacter(id, this.combatant.active);
    } else {
      const i = this.bots.bots.findIndex((b) => b.id === who);
      const a = i >= 0 ? this.bots.setBotCharacter(i, { id, ...model }) : null;
      if (!a) return false;
      avatar = a;
    }
    const prevExpr = this.appearances.get(who)?.expressionOverride ?? null;
    const appearance = this.createAppearance(avatar.bodyMeshes, id, mask, deadEyes);
    // 교체해도 지금 생사·디버그 표정 고정은 이어감
    appearance.setDead(who === this.combatant.id ? this.dead : !(this.bots.bots.find((b) => b.id === who)?.alive ?? true));
    appearance.setExpressionOverride(prevExpr);
    this.appearances.set(who, appearance);
    this.applyAppearance(who);
    return true;
  }

  /**
   * 캐릭터 외형 생성. 그 캐릭터의 첫 외형이면 공유 지오메트리(GLB 캐시 원본·모든 복제가 같이 씀)에 눈동자 평탄화 모프가 이때 붙는다.
   * 그 전에 만든 같은 캐릭터 복제(로비 다른 플레이어·봇·쇼케이스 미리보기)는 모프 영향도 배열이 없어
   * 렌더러가 그림자 패스에서 매 프레임 오류를 내고 화면이 멈춤 → 장면·봇의 그런 메시에 영향도 배열을 만들어 둠 (값 0 = 평소 눈)
   */
  private createAppearance(meshes: readonly THREE.Mesh[], id: CharacterId, mask: THREE.Texture, deadEyes?: DeadEyes): CharacterAppearance {
    const appearance = new CharacterAppearance(meshes, id, mask, deadEyes);
    const fix = (o: THREE.Object3D) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && !mesh.morphTargetInfluences && mesh.geometry?.morphAttributes.position?.length) mesh.updateMorphTargets();
    };
    this.scene.traverse(fix);
    // 장면 밖에 잠시 빠져 있는 봇 아바타도 (다시 장면에 들어오면 같은 오류)
    for (const b of this.bots?.bots ?? []) b.avatar.root.traverse(fix);
    return appearance;
  }

  /** 사망 눈 데이터 (없거나 실패하면 표정 변경 없이 진행, 경고만) */
  private loadDeadEyesSafe(id: CharacterId): Promise<DeadEyes | undefined> {
    return loadDeadEyes(CHARACTERS[id]).catch((err) => {
      console.warn(`[character] ${id} 사망 표정 데이터를 못 읽음`, err);
      return undefined;
    });
  }

  /**
   * 개발용 표정 미리보기 (CHARACTER DEBUG, 콘솔 __game.setExpression('player', 'dead')). 개발 서버에서만.
   * 'normal' / 'dead' = 고정, null = 원래대로(생사를 따름). HP·사망 판정·킬로그·킬 수와 무관
   */
  setExpression(who: string, e: Expression | null): boolean {
    if (!import.meta.env.DEV) return false;
    const a = this.appearances.get(who);
    if (!a) return false;
    a.setExpressionOverride(e);
    return true;
  }

  private expressionOf(id: string): { expression: Expression; expressionLocked: boolean; expressionInfo: string } {
    const a = this.appearances.get(id);
    const d = a?.expressionDebug;
    const info = d ? `${d.method} · 사각형 ${d.rects}(눈 ${d.sides}) · 아틀라스 ${d.atlas} · 섞기 ${d.mix} · 셰이프 키 ${d.morph ? '있음' : '없음'} · 눈 메시 없음(텍스처)` : '';
    return { expression: a?.expression ?? 'normal', expressionLocked: (a?.expressionOverride ?? null) !== null, expressionInfo: info };
  }

  /** CHARACTER DEBUG 표시 대상 (플레이어 + 봇) */
  private debugParticipants(): DebugParticipant[] {
    const list: DebugParticipant[] = [
      {
        id: this.combatant.id,
        label: '플레이어',
        avatar: this.avatar,
        hitboxes: this.combatant.hitboxes,
        alive: !this.dead,
        hp: this.combatant.health.hp,
        maxHp: this.combatant.health.maxHp,
        speedScale: this.player.speedScale,
        ...this.expressionOf(this.combatant.id),
      },
    ];
    for (const b of this.bots.bots) {
      list.push({ id: b.id, label: b.name, avatar: b.avatar, hitboxes: b.hitboxes, alive: b.alive, hp: b.health.hp, maxHp: b.health.maxHp, speedScale: b.controller.speedScale, ...this.expressionOf(b.id) });
    }
    return list;
  }

  /** 로드아웃 주무기 선택: 게임 시작 전에만. @returns 바뀌었으면 true */
  /** 개발용 무적 켜기/끄기 (인자 없으면 전환). 콘솔: __game.god() */
  god(on = !this.combatant.invincible): boolean {
    this.combatant.invincible = on;
    console.info(`[debug] 무적 ${on ? 'ON' : 'OFF'}`);
    this.debugPanel?.refresh();
    return on;
  }

  /** 개발용 총구 디버그 켜기/끄기 (개발 서버에서만). 콘솔: __game.setMuzzleDebug(true) */
  setMuzzleDebug(on: boolean): boolean {
    if (!import.meta.env.DEV) return false;
    if (!this.muzzleDebug) this.muzzleDebug = new MuzzleDebug(this.scene);
    this.muzzleDebug.enabled = on;
    return on;
  }

  /**
   * 개발용 사격 경로 디버그 켜기/끄기 (개발 서버에서만, 인자 없으면 전환). 콘솔: __game.setShotDebug(true)
   * 카메라 조준 레이·조준 목표·총구·실제 탄 경로·충돌 위치·충돌 물체를 장면에 표시 (ShotPathDebug)
   */
  setShotDebug(on = !this.shotDebug?.enabled): boolean {
    if (!import.meta.env.DEV) return false;
    if (!this.shotDebug) this.shotDebug = new ShotPathDebug(this.scene, this.physics);
    this.shotDebug.enabled = on;
    this.weapons.traceDebug = on;
    this.debugPanel?.refresh();
    return on;
  }

  /** 디버그 패널: 자세 보기 카메라 켜기/끄기 (끄면 일반 TPS 카메라) */
  private setPoseView(on: boolean): void {
    this.poseView.on = on;
    if (!on) this.inspectOrbit = null;
  }

  // ---------------- 메인 로비 ----------------

  /** 설정 창 슬라이더 (로비 SETTINGS·매치 일시정지 메뉴 공용, 실제로 적용되는 값만) */
  private settingSliders(): { sound: LobbySlider[]; controls: LobbySlider[]; touch: LobbySlider[] } {
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const x = (v: number) => `${v.toFixed(1)}×`;
    const user = (key: keyof typeof USER_LIMITS, label: string, format: (v: number) => string, apply: (v: number) => void): LobbySlider => ({
      label,
      min: USER_LIMITS[key][0],
      max: USER_LIMITS[key][1],
      step: USER_LIMITS[key][2],
      get: () => this.userSettings[key],
      set: (v) => {
        this.userSettings[key] = v;
        apply(v);
        saveUserSettings(this.userSettings);
      },
      format,
    });
    const touch = (key: keyof typeof TOUCH_LIMITS, label: string, format: (v: number) => string): LobbySlider => ({
      label,
      min: TOUCH_LIMITS[key][0],
      max: TOUCH_LIMITS[key][1],
      step: TOUCH_LIMITS[key][2],
      get: () => this.input.touch.settings[key],
      set: (v) => this.input.touch.setSettings({ [key]: v }),
      format,
    });
    return {
      sound: [
        user('master', '전체 소리', pct, (v) => this.audio.setMaster(v)),
        user('volume', '효과음', pct, (v) => this.audio.setVolume(v)),
        user('music', '배경음', pct, (v) => this.audio.setMusicVolume(v)),
        { ...user('muted', '음소거', (v) => (v >= 0.5 ? '켜짐' : '꺼짐'), (v) => this.audio.setMuted(v >= 0.5)), toggle: true },
      ],
      controls: [user('mouseSensitivity', '마우스 감도', x, (v) => (this.input.mouseSensitivity = v))],
      touch: [touch('lookSensitivity', '시점 회전 감도', x), touch('joystickScale', '조이스틱 크기', pct), touch('buttonScale', '버튼 크기', pct)],
    };
  }

  /**
   * 첫 플레이 안내: 로비 자유 이동 중엔 이동 → 점프, 첫 매치 전투 중엔 이동 → 시점 → 사격 → 무기 교체.
   * 이번 프레임 입력으로 해 봤는지 판단 (조작 로직은 그대로). 다 하면 이 기기에 저장돼 다시 안 나옴
   */
  private updateCoach(dt: number): void {
    const c = this.coach;
    // 로비: 메뉴 패널·멀티 창·닉네임 창·확장 화면 질문이 위에 있으면 잠깐 숨김 (흐름은 유지)
    const overlay = this.lobbyMenuOpen || !!this.mpMenu?.isOpen || !!this.container.querySelector('.fs-offer, .lb-nickname-modal:not([aria-hidden="true"])');
    const lobbyFree = this.lobbyShown && !this.resultScreen?.open && !!this.nick;
    const fighting = !this.lobbyShown && this.match.state === 'PLAYING' && this.input.isLocked && !this.dead && !this.resultScreen?.open && !this.pauseMenu?.visible;
    const want = lobbyFree ? 'lobby' : fighting ? 'match' : null;
    if (c.active && c.active !== want) c.stop();
    if (want === 'lobby') c.start('lobby', LOBBY_COACH);
    else if (want === 'match') c.start('match', MATCH_COACH);
    if (!want) return;
    c.setPlace(want);
    if (want === 'lobby' && overlay) return c.hold();
    // 이동 단계: 단계가 바뀌면 거리 0부터, 이동 입력이 있는 동안 실제 위치 변화만 셈
    const key = c.step;
    if (key !== this.coachStepKey) {
      this.coachStepKey = key;
      this.coachMoved = 0;
      this.coachLastFeet.copy(this.renderFeet);
    }
    const s = this.input.state;
    const moving = s.moveX !== 0 || s.moveY !== 0;
    const dx = this.renderFeet.x - this.coachLastFeet.x;
    const dz = this.renderFeet.z - this.coachLastFeet.z;
    if (moving) this.coachMoved += Math.min(Math.hypot(dx, dz), 2);
    this.coachLastFeet.copy(this.renderFeet);
    c.update(dt, this.input.touchMode, (id) =>
      id === 'move'
        ? moving && this.coachMoved >= 1.2
        : id === 'look'
          ? s.lookDX !== 0 || s.lookDY !== 0
          : id === 'fire'
            ? s.fireHeld
            : id === 'switch'
              ? s.slotPressed > 0 || s.wheelSteps !== 0
              : id === 'jump'
                ? s.jumpPressed
                : false,
    );
  }

  /** 매치 진행 중 (연습전: 카운트다운·전투, 멀티: 방의 매치가 결과 단계 전) */
  private get matchRunning(): boolean {
    const s = this.net?.session;
    return this.netGame ? !!s?.inRoom && s.inMatch && s.matchPhase !== 'result' : this.match.state === 'COUNTDOWN' || this.match.state === 'PLAYING';
  }

  /**
   * 매 프레임 소리 상태: 화면별 배경음(로비·전투·결과), 카운트다운, 발소리 등을 낼 캐릭터 (내 캐릭터 + 매치 중 봇·원격 플레이어)
   */
  private updateSounds(): void {
    const running = this.matchRunning;
    const music: MusicId | null = this.resultScreen?.open ? this.resultMusic : running ? 'battle' : 'lobby';
    const actors = this.soundActors;
    actors.length = 0;
    actors.push({ key: 'me', avatar: this.avatar, pos: this.renderFeet, local: true });
    if (running && !this.botsRemoved) for (const b of this.bots.bots) actors.push({ key: b.id, avatar: b.avatar, pos: b.renderFeet, local: false });
    if (running && this.net) for (const r of this.net.remotes.values()) if (r.alive) actors.push({ key: r.id, avatar: r.avatar, pos: r.renderFeet, local: false });
    this.sounds.update({
      camera: this.tpsCamera.camera,
      actors,
      music,
      countdown: this.match.state === 'COUNTDOWN' ? this.match.countdownLeft : null,
    });
  }

  /**
   * 매치 일시정지 메뉴 표시: 매치 진행 중(카운트다운·전투)인데 조작(포인터 잠금·터치 조작)이 꺼져 있을 때.
   * 결과 화면·멀티 대기실·재접속 화면·디버그 패널이 떠 있을 때는 그쪽이 우선
   */
  private syncPauseMenu(): void {
    const pm = this.pauseMenu;
    if (!pm) return;
    const running = this.matchRunning;
    if (this.inLobby) this.matchLockSeen = false;
    const want = running && !this.inLobby && !this.input.isLocked && !this.debugPanel.visible;
    // 매치 시작 직후 포인터 잠금이 잡히는 사이(몇 프레임)에는 열지 않음 → 0.15초 넘게 조작이 없을 때만
    const now = performance.now();
    if (!want) this.pauseWantSince = -1;
    else if (this.pauseWantSince < 0) this.pauseWantSince = now;
    const open = want && now - this.pauseWantSince >= 150;
    if (open && !pm.visible) {
      const kind = this.pauseKind();
      pm.show(kind.kind, kind.note);
      if (kind.kind === 'lock') pm.showLock(this.lockInfo());
      this.sounds.ui('uiOpen');
    } else if (!want && pm.visible) {
      pm.hide();
      this.sounds.ui('uiClose');
    }
  }

  /**
   * 일시정지 화면 종류: 이번 매치에서 아직 마우스를 고정한 적 없음·브라우저 거부 → 마우스 고정 안내,
   * ESC → 일반 일시정지, 창·iframe 포커스 잃음 / 탭 숨김 → 일반 일시정지 + 이유 한 줄. 터치는 항상 일반
   */
  private pauseKind(): { kind: 'pause' | 'lock'; note: string } {
    if (this.input.touchMode) return { kind: 'pause', note: '' };
    const why = this.input.kbm.lastUnlock;
    if (!this.matchLockSeen || why === 'error' || why === 'none') return { kind: 'lock', note: '' };
    if (why === 'blur') return { kind: 'pause', note: '게임 화면 밖을 눌러서 멈췄어요' };
    if (why === 'hidden') return { kind: 'pause', note: '다른 탭·창으로 이동해서 멈췄어요' };
    return { kind: 'pause', note: '' };
  }

  /** 마우스 고정 안내 내용: 거부 횟수, 임베드에서 계속 거부되면 확장 화면 권유 (한 화면 안의 버튼으로만, 반복 팝업 없음) */
  private lockInfo(): { errors: number; suggestFullscreen: boolean; blocked: boolean } {
    const errors = this.input.kbm.lockErrors;
    const { embedded, policy } = this.input.kbm.lockSupport();
    const blocked = policy === false;
    const canExpand = fullscreenAvailable() && !isExpanded();
    // 수동 테스트용 기록 (토큰·계정 정보 없음): 거부 횟수·임베드·정책
    if (errors > 0) console.info('[pointer-lock]', { errors, embedded, policy, lastUnlock: this.input.kbm.lastUnlock });
    return { errors, blocked, suggestFullscreen: canExpand && (blocked || (embedded && errors >= 2)) };
  }

  /** 브라우저가 포인터 잠금을 거부했거나 잡자마자 풀림: 매치 중이면 마우스 고정 안내 (이미 열려 있으면 내용만 갱신) */
  private onLockFailed(): void {
    if (this.inLobby || this.input.touchMode) return;
    const pm = this.pauseMenu;
    if (pm?.visible) pm.showLock(this.lockInfo());
  }

  /** 일시정지 메뉴가 게임에 요청하는 동작 */
  private pauseHost(): PauseHost {
    return {
      // 계속하기: 버튼 클릭(사용자 동작) 안에서 포인터 잠금·터치 조작 요청 → 성공하면 다음 프레임에 메뉴가 닫힘
      resume: () => this.input.requestLock(),
      settings: () => this.settingSliders(),
      touch: () => this.input.touchMode,
      matchLabel: () => {
        if (!this.netGame) return '연습전 · 개인전 4인';
        const mode = this.net?.session.mode;
        return mode === 'tdm' ? '멀티플레이 · 팀 데스매치 (최대 4:4)' : mode === 'ffa' ? '멀티플레이 · 개인전 (최대 8인)' : '멀티플레이 · 자유 테스트';
      },
      multiplayer: () => this.netGame,
      leaveMatch: async () => {
        await this.returnToLobby();
        this.pauseMenu?.hide();
      },
      // 확장 화면: 고른 것으로 기억 (설정 스위치와 같은 값), 전환 뒤 '게임 화면 활성화'로 고정
      fullscreen: () => void setExpanded(true),
    };
  }

  /** 로비가 게임에 요청하는 동작 (실제로 있는 기능만 연결) */
  private lobbyHost(): LobbyHost {
    return {
      // 카드 순서 = 표시 순서 (잠긴 SHONI·BAM 맨 뒤), 이름 = 표시 이름 (id는 그대로)
      characters: () =>
        CHARACTER_DISPLAY_ORDER.map((id) => {
          const c = CHARACTERS[id];
          const sel = CHARACTER_SELECT[id];
          return { id, name: c.name, role: sel.role, color: sel.color, maxHp: c.stats.maxHp, speed: c.stats.speed, locked: !isCharacterSelectable(id), selectable: isCharacterSelectable(id) };
        }),
      currentCharacter: () => this.avatar.character.id,
      // 유료 캐릭터 (VXShop): 상품 상태 · 공식 결제창 · 반영 재확인 · 변경 알림
      characterOffer: (id) => this.shop.offer(id),
      buyCharacter: (id) => {
        this.sounds.ui('uiSelect');
        void this.shop.buy(id);
      },
      returnPurchaseFullscreen: (id) => void this.shop.returnToFullscreen(id),
      recheckPurchase: (id) => void this.shop.recheck(id),
      shopStatus: () => this.shop.status(),
      onShopChange: (cb) => this.shop.onChange(cb),
      selectCharacter: (id) => {
        this.sounds.ui('uiSelect');
        return this.selectCharacter(id as CharacterId);
      },
      previewCharacter: (id) => this.previewCharacter(id),
      previewedCharacter: () => this.previewedCharacter,
      rotatePreview: (dx) => this.rotatePreview(dx),
      resetPreviewRotation: () => this.resetPreviewSpin(),
      primaryWeapons: () => PRIMARY_WEAPONS.map(lobbyWeapon),
      weaponImage: (id) => this.weaponArt.image(id),
      characterPortrait: (id) => (id in CHARACTERS ? this.characterArt.portrait(id) : Promise.reject(new Error('unknown character'))),
      characterFullBody: (id) => (id in CHARACTERS ? this.characterArt.fullBody(id) : Promise.reject(new Error('unknown character'))),
      weaponPreview: (canvas) => {
        const p = { canvas, id: '', yaw: 0, dirty: false };
        this.weaponPreviews.add(p);
        return {
          show: (id, yaw) => {
            if (p.id === id && p.yaw === yaw) return;
            p.id = id;
            p.yaw = yaw;
            p.dirty = true;
          },
          redraw: () => (p.dirty = true),
          dispose: () => void this.weaponPreviews.delete(p),
        };
      },
      fixedWeapons: () => ({ secondary: lobbyWeapon(SECONDARY_WEAPON), melee: lobbyWeapon(MELEE_WEAPON) }),
      currentPrimary: () => this.primary.id,
      selectPrimary: (id) => {
        this.sounds.ui('uiEquip');
        void this.selectPrimary(id);
      },
      // 연습전 시작 (로비 공간을 치우고 경기장 스폰으로) + 버튼 클릭(사용자 동작) 안에서 포인터 잠금/터치 시작 → 바로 조작
      playPractice: () =>
        // 처음 매치: 확장 화면 추천 (고른 버튼 클릭 안에서 이어서 시작 → 포인터 잠금이 막히지 않음)
        withFullscreenOffer(this.container, this.input.touchMode, () => {
          // 멀티 입장 때 지운 봇은 로비로 돌아올 때 다시 만듦 (혹시 남아 있으면 여기서)
          if (this.botsRemoved) this.rebuildBots();
          this.startMatch();
          this.input.requestLock();
        }),
      openMultiplayer: (mode) => {
        this.mpMenu?.openWith(mode);
        this.refreshMultiplayerMenu();
      },
      lastRoomCode: () => this.net?.session.lastRoomId ?? readLastRoomCode(),
      rejoinLastRoom: () => {
        this.mpMenu?.openWith(null);
        this.mpMenu?.rejoinNow();
      },
      settings: () => this.settingSliders(),
      panelChanged: (centerX) => (this.lobbyCenterX = centerX),
      uiAreaChanged: (area) => (this.lobbyUiArea = area),
      menuChanged: (open, panel) => this.onLobbyMenu(open, panel),
      // 표시용 닉네임: 서버(계정별 글로벌 사용자 상태)가 최종 검사·저장, 이 기기에도 사본 (서버 식별은 계정)
      playerName: () => this.nick ?? '플레이어',
      progress: () => levelInfo(this.myXp),
      ranking: () => this.ranking(),
      nickname: () => this.nick,
      nicknameMustChange: () => this.nickMustChange,
      nicknameReady: () => this.nickReady,
      setNickname: (raw) => this.setNickname(raw),
      presence: () => this.lobbyPresence(),
      retryLobby: () => this.hub?.retryNow(),
      listRooms: () => this.listRooms(),
      createRoom: (mode) => withFullscreenOffer(this.container, this.input.touchMode, () => this.mpMenu?.createNow(mode)),
      joinRoom: (code) => withFullscreenOffer(this.container, this.input.touchMode, () => this.mpMenu?.joinNow(code)),
      quickMatch: () => withFullscreenOffer(this.container, this.input.touchMode, () => this.mpMenu?.quickMatchNow()),
    };
  }

  /**
   * TAB 메뉴 열림·닫힘·패널 변경 (로비가 사용자 동작 처리 안에서 부름).
   * 열림 = 이동·시점 입력 멈춤 + 커서 보이기(포인터 잠금·터치 조작 해제 → 눌려 있던 키·조이스틱도 비움),
   * 닫힘 = 같은 사용자 동작 안에서 포인터 잠금·터치 조작을 다시 요청 (브라우저가 거부하면 "클릭해서 움직이기" 안내)
   */
  private onLobbyMenu(open: boolean, panel: string | null): void {
    if (open !== this.lobbyMenuOpen) this.sounds.ui(open ? 'uiOpen' : 'uiClose');
    this.lobbyMenuOpen = open;
    this.lobbyPanel = open ? panel : null;
  }

  /**
   * 닉네임 정하기·바꾸기: 1차 검사(서버와 같은 checkNickname) → 서버 최종 검사·저장(nickSet, 승인된 값만 퍼짐) →
   * 이 기기 저장 → 로비·다음 방 입장에 반영. 실패하면 이전 닉네임 그대로. 저장 중 다시 부르면 같은 요청 결과 (중복 전송 없음).
   * 서버 없는 빌드(verse 없음)는 이 기기에만 저장. 개발 서버에서 연결한 preview 서버에 아직 nickSet이 없으면(배포 전) 이 기기에만 저장
   */
  private setNickname(raw: string): Promise<NicknameResult> {
    if (!this.nickSaving) this.nickSaving = this.saveNickname(raw).finally(() => (this.nickSaving = null));
    return this.nickSaving;
  }

  private async saveNickname(raw: string): Promise<NicknameResult> {
    const r = checkNickname(raw);
    if (!r.ok) return { ok: false, reason: r.reason };
    if (r.value === this.nick) return { ok: true, value: r.value };
    let sentToServer = false;
    if (this.netClient.status !== 'no-verse') {
      try {
        if (!(await withTimeout(this.netClient.connect(), 8000))) return { ok: false, reason: 'server' };
        const s = await withTimeout(this.netClient.call<{ ok: boolean; nick?: string; reason?: string; retryMs?: number }>('nickSet', [r.value]), 8000);
        if (!s.ok) {
          const reason = isNickReason(s.reason) ? s.reason : 'server';
          return { ok: false, reason, ...(reason === 'rate' && typeof s.retryMs === 'number' ? { retryMs: s.retryMs } : {}) };
        }
        sentToServer = true;
      } catch (e) {
        if (!import.meta.env.DEV || !/function not found/i.test(errText(e))) return { ok: false, reason: 'server' };
        this.netClient.addLog('warn', '서버에 nickSet 없음 (배포 전) → 개발 서버라 이 기기에만 저장');
      }
    }
    if (!sentToServer) {
      const left = NICK_CHANGE_MS - (performance.now() - this.nickChangedAt);
      if (this.nick && left > 0) return { ok: false, reason: 'rate', retryMs: left };
    }
    this.nickChangedAt = performance.now();
    this.applyNickname(r.value, !sentToServer);
    return { ok: true, value: r.value };
  }

  /** 닉네임 적용: 이 기기 저장 → 로비(sendHub = 서버에 아직 안 알렸을 때만)·다음 방 입장(hello)·로비 화면 */
  /** 랭킹 조회 (서버 정렬 결과 그대로). 랭킹을 열 때마다 새로 받음 → 레벨·전적 변화가 바로 보임 */
  private async ranking(): Promise<RankingResult> {
    const fail = (reason: string): RankingResult => ({ ok: false, reason, rows: [], mine: null, total: 0 });
    if (this.netClient.status === 'no-verse') return fail('offline');
    try {
      if (!(await withTimeout(this.netClient.connect(), 10000))) return fail('connect');
      const r = await withTimeout(this.netClient.call<RankingResult>('rankingGet'), 10000);
      // 내 레벨도 최신으로 (다른 기기에서 올렸을 수 있음)
      if (r.ok && r.mine) this.lobby?.refresh();
      return r;
    } catch (e) {
      this.netClient.addLog('warn', `랭킹 불러오기 실패: ${errText(e)}`);
      return fail('error');
    }
  }

  /** 저장된 장착 캐릭터가 유료이고 서버 보유가 확인되면 그 캐릭터로 (시작할 때는 보유를 몰라 BLUE로 시작함) */
  private applyOwnedSaved(): void {
    const id = loadSavedCharacterId();
    if (!id || !isPaidCharacter(id) || !this.shop.owns(id) || this.avatar.character.id === id) return;
    if (!this.lobbyShown || this.netGame || this.combatant.active) return;
    void this.selectCharacter(id);
  }

  /** 서버가 알려 준 내 경험치 반영 (사본 저장 + 로비 카드) */
  private setMyXp(xp: number): void {
    if (!Number.isFinite(xp) || xp < 0) return;
    this.myXp = Math.floor(xp);
    saveXpCache(this.myXp);
    this.lobby?.refresh();
  }

  private applyNickname(nick: string, sendHub: boolean): void {
    this.nick = nick;
    this.nickMustChange = false;
    saveNickname(nick);
    this.hub?.setInfo({ nick }, sendHub);
    if (this.net) this.net.session.nick = nick;
    this.lobby?.refresh();
  }

  /**
   * 시작할 때 계정에 저장된 닉네임 확인: 서버 값이 있으면 그 값으로 (첫 설정 창 닫힘), 서버에 없고 이 기기에만 있으면
   * 서버에 올림 (예전 빌드에서 정한 이름). 실패해도 조용히 넘어감 (이 기기 값으로 계속)
   */
  private async syncServerNick(): Promise<void> {
    try {
      if (this.netClient.status === 'no-verse') return;
      if (!(await withTimeout(this.netClient.connect(), 10000))) return;
      const g = await withTimeout(this.netClient.call<{ ok: boolean; nick: string | null; mustChange?: boolean }>('nickGet'), 8000);
      // 리텐션 접속 기록 (계정당 UTC 하루 1번, 응답을 기다리지 않음 — 게임 시작을 늦추지 않음)
      void this.netClient.call('actPing').catch(() => undefined);
      // 레벨·경험치: 서버 저장값 (이전 서버 배포에 함수가 없으면 사본 그대로)
      void this.netClient
        .call<{ ok: boolean; xp: number }>('progressGet')
        .then((p) => this.setMyXp(p.xp))
        .catch(() => undefined);
      if (g.mustChange) {
        // 저장된 이름이 운영 정책에 맞지 않음: 이 기기 사본도 지우고 '변경 필요' 창 (서버에 상태가 남아 새로고침해도 다시 뜸)
        this.nickMustChange = true;
        this.nick = null;
        clearNickname();
        this.lobby?.refresh();
      } else if (g.nick) {
        if (g.nick !== this.nick) this.applyNickname(g.nick, false);
      } else if (this.nick) {
        const s = await withTimeout(this.netClient.call<{ ok: boolean; reason?: string }>('nickSet', [this.nick]), 8000);
        // 이 기기 이름이 지금 규칙(금칙어)에 걸리면 다시 정하게
        if (!s.ok && (s.reason === 'blocked' || s.reason === 'chars' || s.reason === 'length' || s.reason === 'empty')) {
          this.nick = null;
          clearNickname();
          this.lobby?.refresh();
        }
      }
    } catch (e) {
      this.netClient.addLog('warn', `닉네임 불러오기 실패: ${errText(e)}`);
    } finally {
      // 확인이 끝남 (실패해도): 저장된 이름이 없으면 이제 첫 설정 창
      this.nickReady = true;
      this.lobby?.refresh();
    }
  }

  /** 정비소 미리보기 캐릭터 (잠긴 캐릭터 포함, 장착과 별개). 같은 캐릭터면 그대로 */
  previewCharacter(id: string): void {
    if (!(id in CHARACTERS)) return;
    this.previewWant = id as CharacterId;
  }

  /** 정비소 미리보기 드래그 회전 (px → rad, 화면 오른쪽으로 끌면 캐릭터가 오른쪽으로 돎) */
  rotatePreview(dxPx: number): void {
    this.previewSpin = (this.previewSpin + dxPx * 0.012) % (Math.PI * 2);
  }

  /** 미리보기 회전 정면으로 */
  resetPreviewSpin(): void {
    this.previewSpin = 0;
  }

  /** 지금 로비에 보이는 캐릭터 (미리보기) */
  get previewedCharacter(): string {
    return this.previewWant ?? this.avatar.character.id;
  }

  /**
   * 로비 미리보기 아바타 갱신 (로비 카메라가 매 프레임 호출). 원하는 캐릭터·무기와 다르면 새로 만들고 이전 것은 해제.
   * 준비되기 전에는 실제 플레이어 아바타를 그대로 보여 줌. @returns 화면에 보이는 아바타 (카메라 프레이밍 기준)
   */
  private updateLobbyPreview(dt: number): PlayerAvatar {
    const want = this.previewWant ?? this.avatar.character.id;
    const weapon = this.weapons.def;
    const cur = this.preview;
    if ((!cur || cur.id !== want || cur.weaponId !== weapon.id) && this.previewToken >= 0) void this.buildPreview(want, weapon);
    const p = this.preview;
    this.avatar.root.visible = !p;
    if (!p) return this.avatar;
    // 교체 연출: 살짝 작게 → 통통 튀며 원래 크기 (모델 비율은 그대로, 루트만)
    this.previewPop = Math.min(1, this.previewPop + dt / 0.35);
    const t = this.previewPop;
    const pop = t < 1 ? 1 - 0.14 * Math.cos(t * Math.PI * 1.5) * (1 - t) : 1;
    p.avatar.root.scale.setScalar(pop);
    const yaw = this.bodyYaw + this.showcaseFace + this.previewSpin;
    p.avatar.update({
      dt,
      feet: this.renderFeet,
      bodyYaw: yaw,
      aimDir: _v1.set(Math.sin(yaw), 0, Math.cos(yaw)),
      pitch: 0,
      mode: 'ground',
      grounded: true,
      sprinting: false,
      velocity: _v2.set(0, 0, 0),
      justJumped: false,
      justLanded: false,
      landedAirTime: 0,
      dead: false,
      strafing: false,
      turnInPlace: false,
      weaponKick: 0,
      weaponRaise: 1,
      reloadProgress: 0,
    });
    return p.avatar;
  }

  /** 미리보기 아바타 만들기 (GLB 캐시 복제 + 무기 복제본). 늦게 끝난 이전 요청은 버림 */
  private async buildPreview(id: CharacterId, weapon: WeaponDef): Promise<void> {
    const key = `${id}|${weapon.id}`;
    if (this.previewBuilding === key) return;
    this.previewBuilding = key;
    const token = ++this.previewToken;
    try {
      const model = await this.loadCharacter(id);
      if (token !== this.previewToken || !this.lobbyShown) return;
      const gun = this.weaponModels.get(weapon).clone(true);
      const scene = SkeletonUtils.clone(model.scene);
      // 지오메트리는 캐시 원본과 공유: 같은 캐릭터 아바타의 외형(사망 눈동자 평탄화)이 지오메트리에 모프를 붙였으면
      // 복제 메시에도 모프 영향도 배열이 있어야 함 (없으면 그릴 때 렌더러 오류로 화면이 멈춤)
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && !mesh.morphTargetInfluences && mesh.geometry.morphAttributes.position?.length) mesh.updateMorphTargets();
      });
      const avatar = new PlayerAvatar(scene, model.clips, gun, weapon.mount, id);
      const old = this.preview;
      this.preview = { avatar, id, weaponId: weapon.id };
      this.scene.add(avatar.root);
      old?.avatar.dispose();
      // 같은 캐릭터의 무기만 바뀐 경우는 튀지 않게
      if (!old || old.id !== id) this.previewPop = 0;
    } catch (err) {
      console.warn('[lobby] 미리보기 캐릭터를 불러오지 못함', err);
    } finally {
      if (this.previewBuilding === key) this.previewBuilding = '';
    }
  }

  /** 로비를 닫을 때: 미리보기 해제·실제 아바타 표시 (다시 열면 새로 만듦) */
  private disposePreview(): void {
    this.previewToken++;
    this.previewBuilding = '';
    this.preview?.avatar.dispose();
    this.preview = null;
    this.previewWant = null;
    this.previewSpin = 0;
    this.avatar.root.visible = true;
  }

  /** 로비 표시: 게임 시작 전 + 멀티 메뉴가 덮고 있지 않을 때. 바뀔 때만 HUD·봇 표시를 바꿈 */
  private updateLobbyVisibility(): void {
    const show = !!this.lobby && !this.lobbyDone && !this.mpMenu?.covering;
    if (show === this.lobbyShown) {
      if (show) this.lobby!.refresh();
      return;
    }
    this.lobbyShown = show;
    this.lobby?.setVisible(show);
    this.hud.setLobby(show);
    // 로비 터치 조작: 전투 버튼 숨김 (이동·시점·점프·슬라이딩만)
    this.input.touch.setLobbyMode(show);
    this.input.setLobbyControls(show);
    this.lobbyRoamKey = '';
    this.lobbyFollowReady = false;
    // 로비에서는 봇을 숨김 (경기장에 대기). 매치가 시작되면 다시 보임
    for (const b of this.bots.bots) b.avatar.root.visible = !show;
    if (!show) {
      this.tpsCamera.camera.clearViewOffset();
      this.lobbyShift = 0;
      this.showcaseBlend = 0;
      this.disposePreview();
    }
  }

  /**
   * 로비 고정 구도 따라가기 카메라 (TPS 카메라 결과를 덮어씀). 수평 방향(yaw)은 항상 고정, 위치만 부드럽게 따라감.
   * (예전엔 하늘 탑 근처에서 탑 바깥쪽을 보도록 yaw가 돌았는데, 로비 이동이 카메라 방향 기준이라 나선 경사로에서
   * W만 눌러도 카메라·이동 방향이 서로를 계속 돌려 빙글빙글 돎 → 회전 없이 고정)
   * 하늘 탑 기둥은 당기지 않고 반투명하게 (뒤쪽 나선 발판이 보이도록). 그 밖의 구조물이 가리면 방향은 그대로 두고 거리만 줄임: 레이로 가림을 미리 잡고,
   * 가까워질 때는 빠르게·멀어질 때는 천천히 (갑자기 튀는 줌 방지)
   */
  private updateLobbyFollowCamera(cam: THREE.PerspectiveCamera, dt: number): void {
    const f = this.renderFeet;
    const t = this.lobbyFollow;
    const yaw = LOBBY_CAM.yaw;
    this.lobbyCamYaw = yaw;
    const full = Math.hypot(LOBBY_CAM.distance, LOBBY_CAM.height);
    const reset = !this.lobbyFollowReady || t.distanceToSquared(f) > 400;
    if (reset) {
      t.copy(f);
      this.lobbyCamDist = full;
      this.lobbyFollowReady = true;
    } else {
      const k = 1 - Math.exp(-LOBBY_CAM.followSharpness * dt);
      t.x += (f.x - t.x) * k;
      t.z += (f.z - t.z) * k;
      t.y += (f.y - t.y) * (1 - Math.exp(-LOBBY_CAM.heightSharpness * dt));
    }
    const look = _v1.set(t.x, t.y + LOBBY_CAM.lookHeight, t.z);
    const dir = _v2.set(Math.sin(yaw) * LOBBY_CAM.distance, LOBBY_CAM.height, Math.cos(yaw) * LOBBY_CAM.distance).divideScalar(full);
    // 가림 검사: 가까운 레이(가운데·좌우 0.3m) = 넘으면 벽 안이 보이는 한계, 먼 레이(좌우 1.8m) = 곧 가릴 구조물을 미리 보고
    // 천천히 당기기 시작 (옆으로 걸어 탑 뒤로 갈 때 한 번에 확 당겨지지 않게)
    const side = _v3.set(Math.cos(yaw), 0, -Math.sin(yaw));
    // 하늘 탑 기둥은 가림 검사에서 뺌 → 기둥 뒤로 가도 당기지 않고 기둥을 반투명하게 (아래)
    const pillar = this.lobbySpace?.pillarCollider ?? undefined;
    const ray = (offset: number): number => {
      const hit = this.physics.raycast(_v4.copy(look).addScaledVector(side, offset), dir, full, pillar, this.player.body);
      return hit ? Math.max(LOBBY_CAM_MIN_DIST, hit.distance - 0.35) : full;
    };
    const hard = Math.min(ray(0), ray(0.3), ray(-0.3));
    const soft = Math.min(hard, ray(1.8), ray(-1.8));
    if (reset) this.lobbyCamDist = hard;
    else {
      const sharp = soft < this.lobbyCamDist ? LOBBY_CAM.pullInSharpness : LOBBY_CAM.easeOutSharpness;
      this.lobbyCamDist += (soft - this.lobbyCamDist) * (1 - Math.exp(-sharp * dt));
      // 벽 안으로 들어가지 않게 가까운 레이 거리로 빠르게 맞춤 (순간 이동 대신 몇 프레임에 걸쳐 → 머리 위 발판이 갑자기 지나갈 때 튐 완화)
      if (this.lobbyCamDist > hard) this.lobbyCamDist += (hard - this.lobbyCamDist) * (1 - Math.exp(-LOBBY_CAM.wallSharpness * dt));
    }
    cam.position.copy(look).addScaledVector(dir, this.lobbyCamDist);
    cam.lookAt(look);
    cam.updateMatrixWorld();
    // 탑 기둥이 카메라와 캐릭터(발·머리) 사이, 또는 캐릭터 바로 옆(좌우 2.5m, 나선을 따라 이어지는 다음 발판 자리)을 가리면 기둥만 반투명
    const space = this.lobbySpace;
    if (space) {
      const c = cam.position;
      const sx = Math.cos(yaw) * 2.5;
      const sz = -Math.sin(yaw) * 2.5;
      const blocked =
        space.pillarBetween(c, _v4.set(f.x, f.y + 1.1, f.z), 0.15) ||
        space.pillarBetween(c, _v4.set(f.x, f.y + 0.15, f.z), 0.15) ||
        space.pillarBetween(c, _v4.set(f.x + sx, f.y + 0.6, f.z + sz), 0) ||
        space.pillarBetween(c, _v4.set(f.x - sx, f.y + 0.6, f.z - sz), 0);
      space.fadePillar(blocked ? LOBBY_PILLAR_ALPHA : 1, dt);
    }
  }

  /** 로비 HUD 안내 (클릭해서 움직이기 / 조작 중, PC / 터치). 바뀔 때만 알림 */
  private reportLobbyRoam(): void {
    if (!this.lobbyShown) return;
    const touch = this.input.touchMode;
    // 기기 전환(마우스 ↔ 터치)에도 로비 조작 유지
    this.input.setLobbyControls(true);
    const active = true;
    const key = `${touch}|${active}`;
    if (key === this.lobbyRoamKey) return;
    this.lobbyRoamKey = key;
    this.lobby!.setRoam({ touch, active });
  }

  /**
   * 로비 카메라 전환: 자유 이동 중에는 TPS 카메라 그대로, TAB 메뉴의 CHARACTER(정비소)가 열리면 캐릭터 정면 쇼케이스로 부드럽게 돌아감.
   * 쇼케이스가 완전히 끝나면 미리보기 아바타를 치우고 실제 아바타를 다시 보임
   */
  private updateShowcase(cam: THREE.PerspectiveCamera, dt: number): void {
    this.reportLobbyRoam();
    const want = this.lobbyShown && this.lobbyMenuOpen && this.lobbyPanel === 'character';
    this.showcaseBlend = THREE.MathUtils.clamp(this.showcaseBlend + (want ? dt : -dt) / 0.4, 0, 1);
    if (this.showcaseBlend > 0) {
      this.updateLobbyCamera(cam, dt, THREE.MathUtils.smootherstep(this.showcaseBlend, 0, 1));
    } else {
      if (this.preview || this.previewBuilding) this.disposePreview();
      this.lobbyShift = 0;
      this.applyLobbyLift(cam, dt);
    }
  }

  /**
   * 로비 자유 이동: 방 목록 칸(넓은 화면 오른쪽 · 좁은 화면 아래 시트)을 뺀 빈 3D 영역의 가운데에 내 캐릭터가 오도록
   * 화면(view offset)만 옮김. 카메라 위치·방향은 그대로라 이동 방향·조작·월드 좌표는 바뀌지 않음 (그리는 위치만).
   * 머리는 영역 위, 발은 영역 아래를 넘지 않게 제한. 칸 크기·화면 크기가 바뀌면 매 프레임 다시 계산
   */
  private applyLobbyLift(cam: THREE.PerspectiveCamera, dt: number): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    let wantY = 0;
    let wantX = 0;
    const a = this.lobbyUiArea;
    if (this.lobbyShown && !this.lobbyMenuOpen && a && h > 0 && a.bottom - a.top > 40) {
      const f = this.renderFeet;
      // 지금 화면 좌표(px)에서 지금 옮긴 양을 빼면 옮기기 전 위치. 캐릭터마다 실제 키 (머리 끝)
      const top = Math.max(f.y + 0.6, this.avatar.headCenter.y + this.avatar.headRadius);
      const head = _v1.set(f.x, top, f.z).project(cam);
      const headY = (1 - (head.y + 1) / 2) * h - this.lobbyLift;
      const feet = _v1.set(f.x, f.y, f.z).project(cam);
      const feetY = (1 - (feet.y + 1) / 2) * h - this.lobbyLift;
      const x = ((feet.x + 1) / 2) * w - this.lobbyLiftX;
      const center = (a.top + a.bottom) / 2 - (headY + feetY) / 2;
      const min = a.top + 10 - headY;
      const max = a.bottom - 12 - feetY;
      wantY = max >= min ? THREE.MathUtils.clamp(center, min, max) : min;
      wantX = (a.left + a.right) / 2 - x;
    }
    const k = 1 - Math.exp(-6 * dt);
    this.lobbyLift += (wantY - this.lobbyLift) * k;
    this.lobbyLiftX += (wantX - this.lobbyLiftX) * k;
    if (wantY === 0 && wantX === 0 && Math.abs(this.lobbyLift) < 0.5 && Math.abs(this.lobbyLiftX) < 0.5) {
      this.lobbyLift = 0;
      this.lobbyLiftX = 0;
      if (cam.view?.enabled) cam.clearViewOffset();
      return;
    }
    cam.setViewOffset(w, h, -this.lobbyLiftX, -this.lobbyLift, w, h);
  }

  /**
   * 정비소 쇼케이스 카메라: 미리보기 아바타(대기 자세·장착 무기)를 정면 3/4 각도로 크게. 키에 맞춰 전신이 들어오는 거리,
   * 아주 느린 좌우 흔들림. 오른쪽 패널이 열리면 화면 이동(view offset)으로 캐릭터를 남은 공간 가운데로 (카메라 위치는 그대로).
   * k = TPS 카메라 → 쇼케이스 전환 정도 (캐릭터 주위를 돌아가며 이동, 몸을 뚫고 지나가지 않게)
   */
  private updateLobbyCamera(cam: THREE.PerspectiveCamera, dt: number, k: number): void {
    this.lobbyTime += dt;
    const d = THREE.MathUtils.degToRad;
    const feet = this.renderFeet;
    const shown = this.updateLobbyPreview(dt);
    // 프레이밍은 캐릭터마다 바꾸지 않고 고정 기준 키(가장 큰 BLACK보다 조금 큰 1.4m)로 → 정비소에서 6종 크기 차이가 그대로 보임
    // (BLUE 1.07m는 작게, BLACK 1.35m는 크게). 전신 + 위아래 여유, 캐릭터는 화면 가운데보다 살짝 아래
    const h = Math.max(LOBBY_FRAME_HEIGHT, shown.headCenter.y + shown.headRadius - feet.y);
    const target = _v1.set(feet.x, feet.y + LOBBY_FRAME_HEIGHT * 0.56, feet.z);
    // 세로(전신 + 여유)와 가로(패널을 뺀 빈 공간 폭) 둘 다 들어오는 거리 → 좁은 화면에서도 캐릭터가 버튼·패널 밑으로 넘치지 않음
    const tanV = Math.tan(d(cam.fov) / 2);
    const fullW = Math.max(1, this.container.clientWidth);
    const freeW = this.lobbyCenterX === null ? fullW : Math.min(fullW, Math.max(fullW * 0.3, this.lobbyCenterX * 2));
    const distV = (h * 0.5 * 1.9) / tanV;
    const distH = (h * 0.42 * 1.6) / (tanV * cam.aspect * (freeW / fullW));
    const dist = Math.max(distV, distH);
    // 살짝 내려다봄 → 캐릭터 뒤가 복잡한 배경(기둥·풍선)보다 깨끗한 바닥
    const pitch = d(13);
    // 로비 구조물(무대 턱·상자 등) 옆에 서 있으면 정면 3/4 각도에서 몸이 가려 잘려 보임 → 가리는 것이 없는 각도로 (서 있는 곳이 바뀔 때만 다시 고름)
    const key = `${feet.x.toFixed(1)},${feet.z.toFixed(1)},${this.bodyYaw.toFixed(2)},${dist.toFixed(1)}`;
    if (key !== this.showcaseYawFor) {
      this.showcaseYawFor = key;
      this.showcaseFace = this.clearShowcaseYaw(target, dist, pitch) - d(28);
    }
    const yaw = this.bodyYaw + this.showcaseFace + d(28) + Math.sin(this.lobbyTime * 0.35) * d(5);
    // TPS 카메라 위치를 같은 중심 기준 각도·거리·높이로 보고 그 사이를 보간
    const off = _v2.subVectors(cam.position, target);
    const tpsDist = Math.max(0.5, Math.hypot(off.x, off.z));
    const tpsYaw = Math.atan2(off.x, off.z);
    const yawK = tpsYaw + Math.atan2(Math.sin(yaw - tpsYaw), Math.cos(yaw - tpsYaw)) * k;
    const distK = THREE.MathUtils.lerp(tpsDist, dist * Math.cos(pitch), k);
    const heightK = THREE.MathUtils.lerp(off.y, Math.sin(pitch) * dist, k);
    const tpsQuat = _q1.copy(cam.quaternion);
    cam.position.set(target.x + Math.sin(yawK) * distK, target.y + heightK, target.z + Math.cos(yawK) * distK);
    cam.lookAt(target);
    if (k < 1) cam.quaternion.slerpQuaternions(tpsQuat, _q2.copy(cam.quaternion), k);
    cam.updateMatrixWorld();
    const w = this.container.clientWidth;
    const hpx = this.container.clientHeight;
    const wantShift = this.lobbyCenterX === null ? 0 : (w / 2 - this.lobbyCenterX) * k;
    this.lobbyShift += (wantShift - this.lobbyShift) * (1 - Math.exp(-8 * dt));
    if (Math.abs(this.lobbyShift) < 0.5 && wantShift === 0) {
      if (cam.view) cam.clearViewOffset();
    } else {
      cam.setViewOffset(w, hpx, this.lobbyShift, 0, w, hpx);
    }
  }

  /**
   * 쇼케이스 카메라 방향 고르기 (캐릭터 방향 기준 각도): 28°부터 좌우로 넓혀 가며 발·다리·허리·머리에서 카메라까지
   * 막힌 곳이 없는 첫 방향 (모두 막히면 가장 멀리까지 트인 방향). 캐릭터는 이 방향을 보도록 돌림 (showcaseFace).
   * 실제 보이는 로비 모습으로 검사 (충돌체 없는 장식도 가리므로 물리 레이 대신), 기둥은 로비 카메라처럼 반투명이라 제외
   */
  private clearShowcaseYaw(target: THREE.Vector3, dist: number, pitch: number): number {
    const d = THREE.MathUtils.degToRad;
    const blocker = this.lobbySpace?.viewBlocker;
    if (!blocker) return d(28);
    let best = d(28);
    let bestFree = -1;
    for (const deg of [28, -28, 60, -10, 95, -45, 130, -80, 165, -115, 200, -150]) {
      const yaw = this.bodyYaw + d(deg);
      const cam = _v2.set(target.x + Math.sin(yaw) * Math.cos(pitch) * dist, target.y + Math.sin(pitch) * dist, target.z + Math.cos(yaw) * Math.cos(pitch) * dist);
      let free = Infinity;
      // 발바닥(+3cm)·무릎·허리·머리 높이, 발 높이는 좌우 0.28m도 (가운데 한 줄만 보면 무대 턱이 발·다리를 가리는 걸 놓침)
      const feetY = target.y - LOBBY_FRAME_HEIGHT * 0.56;
      const sx = Math.cos(yaw) * 0.28;
      const sz = -Math.sin(yaw) * 0.28;
      for (const [dy, side] of [[0.03, 0], [0.03, 1], [0.03, -1], [0.3, 0], [0.75, 0], [1.15, 0]] as const) {
        const from = _v3.set(target.x + sx * side, feetY + dy, target.z + sz * side);
        const dir = _v4.subVectors(cam, from);
        const len = dir.length();
        dir.divideScalar(len);
        _showcaseRay.set(from, dir);
        _showcaseRay.far = len;
        const hit = _showcaseRay.intersectObject(blocker, false)[0];
        free = Math.min(free, hit ? hit.distance / len : 1);
      }
      if (free >= 0.999) return d(deg);
      if (free > bestFree) {
        bestFree = free;
        best = d(deg);
      }
    }
    return best;
  }

  /** 로비 단계 끝 (첫 매치·멀티 입장): 로비 공간을 치우고 경기장 첫 스폰으로 (실제 스폰은 이후 매치 규칙이 정함) */
  private releaseLobbySpace(): void {
    if (!this.lobbySpace) return;
    this.lobbySpace.dispose();
    this.lobbySpace = null;
    this.lobbyMenuOpen = false;
    this.lobbyPanel = null;
    this.input.touch.setLobbyMode(false);
    this.input.setLobbyControls(false);
    // 로비 터치 레이어를 끄고, 매치 시작 쪽 잠금 요청이 터치 조작을 새로 켜게 (조작 중 HUD 상태가 맞도록)
    if (this.input.touch.active) this.input.releaseLock();
    this.placeAtSpawn(this.map.spawns.teamA[0]!);
  }

  selectPrimary(id: string): boolean {
    if (this.combatant.active) return false;
    const def = PRIMARY_WEAPONS.find((w) => w.id === id);
    if (!def) return false;
    this.primary = def;
    this.hud.setLoadout(def.id, false);
    // 온라인 로비의 다른 사람 화면에도 새 주무기로
    this.hub?.setInfo({ weapon: def.id });
    // 시작 전 미리 보기: 1번 슬롯으로 들고 있게
    this.switchSlot(0, true);
    return true;
  }

  /** 디버그: 스나이퍼 퀵스왑 상태 (스나이퍼를 한 번이라도 들었을 때만) */
  private quickSwapDebugLines(): string[] {
    const q = this.weapons.quickSwapDebug();
    if (!q) return [];
    const f = (v: number) => (Number.isFinite(v) ? `${v.toFixed(2)}s` : '없음');
    return [
      `스나이퍼 마지막 발사 ${Number.isFinite(q.lastShotAgo) ? `${q.lastShotAgo.toFixed(2)}s 전` : '없음'}  후딜레이 ${q.recovering ? '중' : q.cancelled ? '취소됨(퀵스왑)' : '없음'}  다음 발사까지 ${q.nextShotIn.toFixed(2)}s  실제 간격 ${f(q.lastInterval)}  ${q.equipped ? '장착' : '보관'}`,
    ];
  }

  /** 디버그: 현재 로드아웃·슬롯 */
  get loadoutState(): { primary: string; slot: number; weapon: string } {
    return { primary: this.primary.id, slot: this.slotIndex + 1, weapon: this.weapons.def.id };
  }

  /** 플레이어 피격: 피해 방향·섬광, 체력 0이면 사망 */
  private onPlayerDamaged(hit: HitInfo, applied: number): void {
    // 보호 중 등 실제 피해 0이면 화면 효과 없음
    if (applied > 0) this.tpsCamera.hurtKick(applied / 40);
    this.hud.showDamage(hit.attacker?.position ?? null, applied);
    if (applied > 0 && this.combatant.alive) this.audio.play('hurt');
    if (!this.combatant.alive && !this.dead) this.kill(hit.attacker ?? null, hit, 'weapon');
  }

  /** 첫 클릭(포인터 잠금): 시작 전(WAITING)이면 새 매치 (카운트다운부터) */
  startMatch(): void {
    if (!this.match || this.match.state !== 'WAITING') return;
    // 멀티 테스트: 서버가 시작 상태를 공유하기 전에는 시작하지 않음 (방장 Start Test → 룸 상태)
    if (this.netGame) {
      const s = this.net?.session;
      if (!s?.inRoom || !s.inMatch) return;
      this.beginNetMatch();
      return;
    }
    this.beginMatch();
  }

  /**
   * 새 매치: 기록·타이머·결과 초기화 → 모든 참가자를 겹치지 않는 스폰에서 부활
   * (체력·탄약·사망·무적·ADS·재장전·봇 결정 초기화) → 카운트다운.
   */
  private beginMatch(): void {
    this.sounds.ui('matchEnter');
    this.lobbyDone = true;
    this.releaseLobbySpace();
    this.combatant.active = true;
    // 주무기 고정 (매치 중 변경 불가)
    this.hud.setLoadout(this.primary.id, true);
    this.hud.setCharacter(this.avatar.character.id, true);
    this.match.startCountdown();
    this.dead = false;
    this.hud.clearDamage();
    this.tracers.clear();
    this.deathTimer = 0;
    this.respawn();
    // 매치 시작은 카운트다운 동안 모두 정지 → 시작 보호 없음
    this.combatant.health.protection = 0;
    this.bots.resetForMatch();
    for (const id of this.appearances.keys()) this.applyAppearance(id);
    this.resultScreen?.close();
    this.hud.setMatchOver(false);
    this.hud.clearKillFeed();
  }

  /** HUD 매치 정보 (남은 시간·내 킬/데스·순위·목표) */
  private matchHud(): MatchHudInfo {
    const m = this.match;
    const me = m.stats.get(this.combatant.id);
    const net = this.netGame ? this.netScoreHud() : undefined;
    return {
      net,
      state: m.state,
      timeLeft: m.timeLeft,
      countdown: m.countdownLeft,
      kills: me?.kills ?? 0,
      deaths: me?.deaths ?? 0,
      rank: m.stats.rankOf(this.combatant.id),
      players: m.stats.count,
      scoreToWin: m.rules.scoreToWin,
      label: m.rules.label,
    };
  }

  /**
   * 외형 모드 전환 (개발·확인용, 실제 TDM 규칙은 아직 없음): on = TDM 팀 색 미리보기
   * (플레이어·BOT 1 = BLUE, BOT 2·3 = RED), off = 개인전 원래 색. 콘솔: __game.setTeamPreview(true)
   */
  setTeamPreview(on: boolean): void {
    this.appearanceMode = on ? 'TDM' : 'FFA';
    this.teams.clear();
    if (on) {
      this.teams.set(this.combatant.id, 'BLUE');
      this.bots.bots.forEach((b, i) => this.teams.set(b.id, i === 0 ? 'BLUE' : 'RED'));
    }
    for (const id of this.appearances.keys()) this.applyAppearance(id);
  }

  /** 팀 변경 (개발·확인용, 콘솔: __game.setTeam('bot2', 'BLUE')). 원래 캐릭터 색과 무관 */
  setTeam(id: string, team: TeamId): void {
    this.teams.set(id, team);
    // 내 팀이 바뀌면 모든 이름표(아군/적군) 다시 계산
    for (const pid of this.appearances.keys()) this.applyAppearance(pid);
  }

  /** 디버그 (콘솔): 참가자별 외형 상태 */
  get appearanceState(): Array<{ id: string; character: CharacterId; mode: GameModeId; team: TeamId }> {
    return [...this.appearances].map(([id, a]) => ({ id, character: a.def.id, mode: a.current.mode, team: a.current.team }));
  }

  /** 참가자 1명 외형 적용 (생성·매치 시작·리스폰·팀 변경). 봇 이름표도 아군/적군 색으로 */
  private applyAppearance(id: string): void {
    const team = this.teams.get(id) ?? 'NONE';
    this.appearances.get(id)?.apply({ mode: this.appearanceMode, team });
    const i = this.bots.bots.findIndex((b) => b.id === id);
    if (i >= 0) {
      const mine = this.teams.get(this.combatant.id) ?? 'NONE';
      this.bots.labels[i]!.ally = this.appearanceMode === 'TDM' && team !== 'NONE' && team === mine;
    }
  }

  /** 결과 화면의 다시 플레이 버튼 */
  private replay(): void {
    if (this.match.state !== 'FINISHED') return;
    // 버튼 클릭(사용자 동작) 안에서 포인터 잠금 요청 → 바로 조작 가능 (결과 화면이 열려 있으면 잠금을 막으므로 먼저 닫음)
    this.resultScreen?.close();
    this.input.requestLock();
    this.beginMatch();
  }

  private onMatchState(state: MatchState, prev: MatchState): void {
    if (state === 'PLAYING') {
      this.hud.flashGo();
      if (prev === 'COUNTDOWN') this.audio.play('countGo');
    }
  }

  /** 매치 종료 (한 번만): 전투 정지, 조준·재장전 해제, 결과 화면 (포인터 잠금 해제 → 버튼 클릭 가능) */
  private onMatchFinish(result: MatchResult): void {
    this.aim.reset('death');
    this.weapons.cancelReaim();
    this.weapons.weapon.cancelReload();
    this.hud.setMatchOver(true);
    this.resultScreen?.show(
      fromPracticeResult(result, this.match.rules, this.match.round, (id) => {
        if (id === this.combatant.id) return { nick: this.nick ?? '플레이어', char: this.avatar.character.id };
        const bot = this.bots.bots.find((b) => b.id === id);
        return { nick: bot?.name ?? id, char: bot?.avatar.character.id ?? 'blue' };
      }),
    );
    this.input.releaseLock();
  }

  /**
   * 모바일 에임 보정 (combat/aimAssist.ts): 이번 프레임 터치 회전 입력만 바꿈 (마우스 입력은 그대로).
   * 손가락 입력이 있을 때만, 전투 중·살아 있음·총기일 때. 대상 = 살아 있는 적 몸통 중심 (봇·원격 플레이어), 맵 구조물에 가리면 제외
   */
  private applyTouchAimAssist(): void {
    this.aimAssistOn = null;
    const t = this.input.touch;
    const tdx = t.state.lookDX;
    const tdy = t.state.lookDY;
    if (!this.input.touchMode || !t.active || (tdx === 0 && tdy === 0)) return;
    if (!this.match.combatActive || this.dead || this.lobbyShown || this.weapons.weapon.def.kind === 'melee') return;
    const list = this.assistTargets;
    const ids: string[] = [];
    let n = 0;
    const add = (id: string, fill: (out: THREE.Vector3) => void) => {
      const slot = (list[n] ??= { point: new THREE.Vector3() });
      fill(slot.point);
      ids[n++] = id;
    };
    for (const b of this.bots.bots) if (b.targetable && areHostile(this.combatant, b)) add(b.id, (o) => b.avatar.getChestPosition(o));
    for (const r of this.net?.hostiles() ?? []) if (areHostile(this.combatant, r)) add(r.id, (o) => r.avatar.getChestPosition(o));
    list.length = n;
    if (n === 0) return;
    const out = assistTouchLook(tdx, tdy, this.tpsCamera.camera, list, CAMERA.sensitivity * this.aim.lookSensitivityMultiplier, (a, b) => this.physics.lineClear(a, b));
    if (out.target < 0) return;
    this.aimAssistOn = ids[out.target]!;
    const s = this.input.state;
    s.lookDX += out.dx - tdx;
    s.lookDY += out.dy - tdy;
  }

  /** 디버그 (콘솔): 봇 목록 */
  get botList(): Bot[] {
    return this.bots.bots;
  }

  /** 플레이어 사망 (한 번의 사망에 한 번). killer = 마지막 피해를 준 공격자 (낙사·자살은 null) */
  private kill(killer: AttackerInfo | null, hit: HitInfo | null = null, cause: DeathCause = 'weapon'): void {
    // 네트워크: 자멸은 서버에 알림 (피격 사망은 서버가 이미 판정한 결과로 여기 옴)
    if (cause !== 'weapon') this.net?.selfDeath(cause);
    this.reportDeath(this.combatant.id, killer, hit, cause);
    this.appearances.get(this.combatant.id)?.setDead(true);
    this.audio.play('death');
    this.killedBy = killer?.name ?? null;
    this.match.recordDeath(this.combatant.id, killer?.id ?? null);
    this.combatant.health.kill();
    // 쓰러진 플레이어는 사격 판정 제외 (이동 캡슐은 바닥 충돌용으로 유지)
    this.combatant.hitboxes.setEnabled(false);
    this.dead = true;
    // 사망: 남은 피격 섬광·방향 표시 끝 (궤적은 수명이 짧아 그대로 사라짐)
    this.hud.clearDamage();
    this.deathTimer = MOVEMENT.respawnDelay;
    this.aim.reset('death');
    this.weapons.cancelReaim();
    this.weapons.weapon.cancelReload();
  }

  /**
   * 플레이어 스폰 선택 (맵 스폰 데이터 teamA): 다른 캐릭터와 2.5m 안이면 제외,
   * 적(봇)에게서 가장 멀고 적 눈에서 바로 보이지 않는 곳 우선 (봇 스폰 규칙과 같음)
   */
  private pickPlayerSpawn(): SpawnPoint {
    const list = this.spawnPool.length > 0 ? this.spawnPool : this.map.spawns.teamA;
    let best = list[0]!;
    let bestScore = -Infinity;
    const eye = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (const s of list) {
      p.set(s.x, s.y + 1, s.z);
      let minHostile = 60;
      let blocked = false;
      let seen = false;
      for (const b of this.bots?.bots ?? []) {
        if (!b.alive) continue;
        const f = b.getFeet(eye);
        const d = Math.hypot(f.x - s.x, f.z - s.z);
        if (d < 2.5) blocked = true;
        minHostile = Math.min(minHostile, d);
        if (this.physics.lineClear(b.getEye(eye), p)) seen = true;
      }
      // 네트워크 원격 플레이어도 같은 규칙 (보간 위치 기준)
      for (const r of this.net?.hostiles(this.netGame && COMBAT.hostility === 'teams' ? this.combatant.team : null) ?? []) {
        const d = Math.hypot(r.renderFeet.x - s.x, r.renderFeet.z - s.z);
        if (d < 2.5) blocked = true;
        minHostile = Math.min(minHostile, d);
        if (this.physics.lineClear(eye.copy(r.avatar.headCenter), p)) seen = true;
      }
      if (blocked) continue;
      const score = minHostile - (seen ? 15 : 0) + Math.random() * 2;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }

  /** 스폰 지점에 플레이어 배치 (발 위치 → 캡슐 중심, 바라보는 방향으로 카메라 정렬) */
  private placeAtSpawn(s: SpawnPoint): void {
    const center = new THREE.Vector3(s.x, s.y + this.player.footOffset + 0.05, s.z);
    this.player.teleport(center);
    this.bodyYaw = s.yaw;
    this.tpsCamera.snapBehind(this.bodyYaw, center);
  }

  /**
   * 리스폰 등장 연출 예약 (쏙 튀어나옴 + 파스텔 링·반짝이). 반짝이는 아바타가 새 자리로 옮겨진 다음 프레임 위치에서
   * (예약 목록에 한 번만 → 같은 리스폰이 두 번 와도 한 번)
   */
  private queueSpawnFx(avatar: PlayerAvatar | null | undefined): void {
    if (!avatar || this.spawnFxQueue.includes(avatar)) return;
    avatar.playSpawnPop();
    this.spawnFxQueue.push(avatar);
  }

  /** 매 프레임: 예약된 반짝이 + 스폰 보호 방울 (나·봇은 각자 보호 시간, 원격은 NetGameMode가 서버 기록으로) */
  private updateSpawnFx(): void {
    this.syncNetProtection();
    for (const a of this.spawnFxQueue) {
      const height = Math.max(0.6, a.headCenter.y + a.headRadius - a.root.position.y);
      this.effects.spawnSparkle(a.root.position, height);
    }
    this.spawnFxQueue.length = 0;
    this.avatar.setProtected(!this.dead && !this.lobbyShown && this.combatant.active && this.combatant.health.protection > 0);
    for (const b of this.bots.bots) b.avatar.setProtected(b.alive && b.isProtected);
  }

  private respawn(): void {
    // 전투 중 부활만 (매치 시작 배치는 입장음)
    if (this.dead && this.match.state === 'PLAYING') this.audio.play('respawn');
    this.dead = false;
    this.hud.clearDamage();
    this.queueSpawnFx(this.avatar);
    // 멀티 테스트 시작 때만 자리별 고정 스폰 (P1 / P2 서로 다른 곳), 이후 리스폰은 기존 규칙
    this.placeAtSpawn(this.netSpawn ?? this.pickPlayerSpawn());
    this.netSpawn = null;
    this.aim.reset('respawn', true);
    // 선택한 주무기 유지: 1번 슬롯으로 들고 모든 무기 탄약 보충
    this.switchSlot(0, true);
    this.weapons.resetForRespawn();
    this.combatant.health.reset(COMBAT.player.spawnProtection);
    this.combatant.hitboxes.setEnabled(true);
    this.killedBy = null;
    this.match.respawned(this.combatant.id);
    this.feedDead.delete(this.combatant.id);
    this.appearances.get(this.combatant.id)?.setDead(false);
    this.applyAppearance(this.combatant.id);
  }

  // ---------------- 네트워크 테스트 (?net=1) ----------------

  /** 시작 화면 멀티플레이 테스트 메뉴 (서버 연결은 방 만들기/입장 때 ensureNet) */
  private initMultiplayerMenu(): void {
    this.hud.onMultiplayer = () => {
      this.mpMenu?.open();
      this.refreshMultiplayerMenu();
    };
    this.mpMenu = new MultiplayerMenu(this.container, {
      session: () => this.net?.session ?? null,
      characterName: () => this.avatar.character.name,
      characterLabel: (id) => (id in CHARACTERS ? CHARACTERS[id as CharacterId].name : id),
      characterPortrait: (id) => (id in CHARACTERS ? this.characterArt.portrait(id) : Promise.reject(new Error('unknown character'))),
      characterColor: (id) => (id in CHARACTER_SELECT ? CHARACTER_SELECT[id as CharacterId].color : '#8a94b8'),
      netGame: () => this.netGame,
      leftUnexpectedly: () => this.netGame && !this.netLeftByUser && !this.net?.session.inRoom && !!this.net?.session.lastError,
      locked: () => this.input.isLocked,
      matchStarted: () => this.match.state !== 'WAITING',
      localTeam: () => this.net?.session.players[this.net.session.me]?.team ?? null,
      create: (mode) =>
        this.withHubPaused(async () => {
          const net = this.ensureNet();
          net.session.cancelReconnect();
          this.netLeftByUser = false;
          if (await net.session.createRoom(this.avatar.character.id, mode)) this.enterNetGame();
        }),
      setMode: async (mode) => {
        const r = await this.ensureNet().session.setMode(mode);
        if (!r.ok) this.mpMenu?.setNotice(`모드 변경 실패: ${this.netReason(r.reason)}`);
      },
      switchTeam: async () => {
        const r = await this.ensureNet().session.switchTeam();
        if (!r.ok) this.mpMenu?.setNotice(`팀 변경 실패: ${this.netReason(r.reason)}`);
      },
      moveSeat: async (team, seat) => {
        const r = await this.ensureNet().session.moveSeat(team, seat);
        if (!r.ok) this.mpMenu?.setNotice(`자리 이동 실패: ${this.netReason(r.reason)}`);
      },
      resultOpen: () => !!this.resultScreen?.open,
      join: (code) =>
        this.withHubPaused(async () => {
          const net = this.ensureNet();
          net.session.cancelReconnect();
          this.netLeftByUser = false;
          if (await net.session.joinByCode(this.avatar.character.id, code)) this.enterNetGame();
        }),
      quickMatch: () =>
        this.withHubPaused(async () => {
          const net = this.ensureNet();
          net.session.cancelReconnect();
          this.netLeftByUser = false;
          if (await net.session.quickMatch(this.avatar.character.id)) this.enterNetGame();
        }),
      rejoin: () =>
        this.withHubPaused(async () => {
          const net = this.ensureNet();
          net.session.cancelReconnect();
          this.netLeftByUser = false;
          if (await net.session.rejoin(this.avatar.character.id)) this.enterNetGame();
        }),
      lastRoomCode: () => this.net?.session.lastRoomId ?? readLastRoomCode(),
      start: async (timeLimitSec) => {
        const r = await this.ensureNet().session.startMatch(timeLimitSec);
        if (!r.ok) {
          this.mpMenu?.setNotice(`시작 실패: ${this.netReason(r.reason)}`);
          return;
        }
        // 버튼 클릭(사용자 동작) 직후라 포인터 잠금 요청 가능 → 방장은 바로 조작
        this.input.requestLock();
      },
      leave: async () => {
        this.netLeftByUser = true;
        await this.net?.session.leave();
      },
      cancelReconnect: () => this.net?.session.cancelReconnect(),
      // 메인 로비로 (새로고침 없이): 방을 나가고 로비 공간·로비 서버로 돌아감
      singlePlayer: () => void this.returnToLobby(),
    });
  }

  /**
   * 온라인 로비 (매 프레임): 로비 단계이고 매치 룸에 들어가 있지 않으면 로비 서버에 접속, 아니면 나감.
   * 내 위치는 로비 화면이 떠 있을 때만 보냄 (변화가 있을 때 최대 8회/초). 다른 사람 캐릭터 보간·이름표
   */
  private updateHub(dt: number): void {
    const hub = this.hub;
    if (!hub) return;
    const matchRoom = !!this.net && this.net.session.phase !== 'lobby';
    const want = this.inLobby && !matchRoom && !this.hubHold;
    // 닉네임을 정하기 전에는 로비 서버에 들어가지 않음 (첫 설정 창)
    if (want && this.nick) hub.start(this.avatar.character.id, this.nick, this.primary.id);
    else if (hub.active && !this.hubHold) void hub.stop();
    const p = this.player;
    const v = p.velocity;
    const f = (p.grounded ? 1 : 0) | (p.sprinting && p.grounded ? 2 : 0) | (p.justJumped ? 16 : 0) | (p.justLanded ? 32 : 0);
    const local = this.lobbyShown
      ? { x: this.renderFeet.x, y: this.renderFeet.y, z: this.renderFeet.z, yaw: this.bodyYaw, vx: v.x, vy: v.y, vz: v.z, m: Math.max(0, NET_MODES.indexOf(p.mode)), f }
      : null;
    hub.update(dt, local);
    // 캐릭터 쇼케이스(정비소 미리보기) 중에는 다른 사람 캐릭터를 숨김
    this.peers?.setHidden(this.showcaseBlend > 0);
    this.peers?.update(dt);
    // 내 닉네임도 내 캐릭터 머리 위 (로비 화면에서만)
    this.peers?.updateLocal(this.lobbyShown ? this.avatar : null, this.nick);
    // 개발 진단: 5초마다 로비 전송량·FPS (배포 빌드는 출력 없음)
    if (import.meta.env.DEV && hub.status === 'online') {
      this.hubLogTimer += dt;
      if (this.hubLogTimer >= 5) {
        const c = this.netClient.counters;
        console.info(`[hub] ${hub.roomId} ${hub.count}/${hub.max} · 보냄 ${hub.stats.sent} 건너뜀 ${hub.stats.skipped} · 받은 푸시 ${hub.stats.recv} · 송신 ${c.sentBytes}B 수신 ${c.recvBytes}B · FPS ${this.fps.toFixed(0)}`);
        this.hubLogTimer = 0;
      }
    }
  }

  /** 로비 접속 상태 → 로비 화면 표시값 (실제 접속 완료 때만 인원) */
  private lobbyPresence(): LobbyPresence {
    const hub = this.hub;
    if (!hub) return { status: 'offline', count: null, max: null };
    const map: Record<HubStatus, LobbyPresence['status']> = {
      idle: 'connecting',
      offline: 'offline',
      connecting: 'connecting',
      online: 'online',
      disconnected: 'disconnected',
      reconnecting: 'reconnecting',
    };
    return { status: map[hub.status], count: hub.count, max: hub.status === 'online' ? hub.max : null };
  }

  /** 방 목록 (서버 listRooms). 서버에 함수가 없거나 연결 실패면 ok: false — 목록을 지어내지 않음 */
  private async listRooms(): Promise<{ ok: boolean; reason?: string; rooms: Array<{ code: string; mode: NetMode; title?: number; players: number; maxPlayers: number; phase: NetRoomSummary['phase']; joinable: boolean; reason?: string }> }> {
    try {
      if (!(await this.netClient.connect())) return { ok: false, reason: this.netClient.status === 'no-verse' ? 'offline' : 'connect', rooms: [] };
      const r = await this.netClient.call<{ ok: boolean; rooms: NetRoomSummary[] }>('listRooms');
      if (!r?.ok || !Array.isArray(r.rooms)) return { ok: false, reason: 'error', rooms: [] };
      return {
        ok: true,
        // 자유 테스트 방(연결·전투 점검용, 새 방 기본 모드)은 로비 목록에 안 보임 (코드로는 들어갈 수 있음)
        rooms: r.rooms.filter((x) => x.mode !== 'test').map((x) => ({ code: displayCode(x.roomId), mode: x.mode, ...(typeof x.title === 'number' ? { title: x.title } : {}), players: x.players, maxPlayers: x.max, phase: x.phase, joinable: x.joinable, ...(x.reason ? { reason: x.reason } : {}) })),
      };
    } catch (e) {
      const msg = errText(e);
      this.netClient.addLog('warn', `listRooms: ${msg}`);
      // 서버에 함수가 없음 = 이 기능이 들어간 서버가 아직 배포 안 됨 (연결 실패와 구분)
      return { ok: false, reason: /function not found/i.test(msg) ? 'not_deployed' : 'error', rooms: [] };
    }
  }

  /** 원격 캐릭터 아바타 공통 (로비·매치): GLB 캐시 복제 + 라이플 복제본, 장면에 추가. 외형·판정은 부르는 쪽이 */
  private async createLobbyAvatar(id: CharacterId): Promise<PlayerAvatar> {
    const model = await this.loadCharacter(id);
    const scene = SkeletonUtils.clone(model.scene);
    // 공유 지오메트리에 사망 눈 모프가 붙어 있으면 복제 메시에도 영향도 배열 필요 (없으면 렌더러 오류)
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && !mesh.morphTargetInfluences && mesh.geometry.morphAttributes.position?.length) mesh.updateMorphTargets();
    });
    const avatar = new PlayerAvatar(scene, model.clips, this.weaponModels.get(RIFLE).clone(true), RIFLE_MOUNT, id);
    this.scene.add(avatar.root);
    return avatar;
  }

  /**
   * 매치 룸에 들어가기 전: 로비 룸을 먼저 나감 (같은 계정은 룸이 하나 — 로비 위치 전송·구독·원격 캐릭터 정리).
   * 들어가지 못하고 로비에 남으면 다음 프레임에 로비 서버에 다시 연결
   */
  private async withHubPaused(fn: () => Promise<void>): Promise<void> {
    return this.runRoomTransition(async () => {
      this.hubHold = true;
      try {
        await this.hub?.stop();
        await fn();
      } finally {
        this.hubHold = false;
      }
    });
  }

  /** 방 입장·퇴장 작업 하나만 실행하고, 호출자는 같은 진행 중 Promise를 기다린다. */
  private runRoomTransition(fn: () => Promise<void>): Promise<void> {
    if (this.roomTransition) return this.roomTransition;
    // 이 finally가 끝나기 전에는 새 전환이 시작될 수 없으므로 현재 항목을 안전하게 비울 수 있다.
    const task = fn().finally(() => {
      this.roomTransition = null;
    });
    this.roomTransition = task;
    return task;
  }

  /**
   * 매치 결과·멀티 방에서 메인 로비로 (새로고침 없이): 방에서 나가고(멀티) 매치 상태를 대기로 되돌린 뒤
   * 로비 공간을 다시 만들고 커서 조작으로. 매치 리소스(원격 플레이어·멀티 HUD)는 정리.
   * 멀티 입장 때 봇을 지웠으면 여기서 다시 만듦 (연습전은 새로고침 없이)
   */
  private async returnToLobby(): Promise<void> {
    if (this.inLobby) return;
    // 입장/재접속 처리가 끝나기 전에 누른 로비 요청도 버리지 않고 바로 이어서 수행한다.
    if (this.roomTransition) {
      try {
        await this.roomTransition;
      } catch {
        // 실패한 입장/재접속 뒤에도 로비 복귀 요청 자체는 계속 처리한다.
      }
    }
    if (this.inLobby) return;
    await this.runRoomTransition(() => this.leaveMatchToLobby());
  }

  /** returnToLobby 본체 (매치 룸 퇴장 → 매치 정리 → 로비 공간·로비 서버) */
  private async leaveMatchToLobby(): Promise<void> {
    const session = this.net?.session;
    if (session?.inRoom) {
      this.netLeftByUser = true;
      // 퇴장 응답이 늦어도(최대 1.5초) 로컬은 방에서 나온 상태로 정리됨 (NetSession.leave)
      await session.leave();
    }
    session?.cancelReconnect();
    this.mpMenu?.close();
    this.input.releaseLock();
    if (this.netGame) {
      this.netGame = false;
      this.netHud?.dispose();
      this.netHud = null;
      this.netModeKey = '';
      this.netSpawn = null;
      this.combatant.team = TEAMS.player;
    }
    // 개인전 규칙·새 매치 (대기)
    const rules = FFA_RULES;
    COMBAT.hostility = rules.hostility;
    const allSpawns = [...this.map.spawns.teamA, ...this.map.spawns.teamB];
    this.spawnPool = rules.spawns === 'all' ? allSpawns : this.map.spawns.teamA;
    // 멀티 입장 때 지운 봇을 다시 (연습전을 새로고침 없이)
    if (this.botsRemoved) this.rebuildBots();
    this.match = new Match(rules, {
      onStateChange: (state, prev) => this.onMatchState(state, prev),
      onFinish: (result) => this.onMatchFinish(result),
    });
    this.match.stats.register({ id: this.combatant.id, name: '나', isLocal: true });
    for (const b of this.bots.bots) this.match.stats.register({ id: b.id, name: b.name, isLocal: false });
    this.appearanceMode = 'FFA';
    this.teams.clear();
    // 플레이어 상태 초기화 (사망·체력·조준·재장전·무기) + 남은 피격·궤적 연출
    this.combatant.active = false;
    this.dead = false;
    this.hud.clearDamage();
    this.tracers.clear();
    this.deathTimer = 0;
    this.killedBy = null;
    this.combatant.health.reset(0);
    this.combatant.hitboxes.setEnabled(true);
    this.aim.reset('respawn', true);
    this.weapons.cancelReaim();
    this.weapons.weapon.cancelReload();
    this.switchSlot(0, true);
    this.weapons.resetForRespawn();
    this.feedDead.clear();
    for (const id of this.appearances.keys()) {
      this.appearances.get(id)?.setDead(false);
      this.applyAppearance(id);
    }
    this.resultScreen?.close();
    this.resultScreen?.forgetSeen();
    this.hud.setMatchOver(false);
    this.hud.clearKillFeed();
    this.hud.setCharacter(this.avatar.character.id, false);
    this.hud.setLoadout(this.primary.id, false);
    // 로비 공간 다시 (메뉴 닫힌 자유 이동 상태로)
    this.lobbyDone = false;
    this.lobbyMenuOpen = false;
    this.lobbyPanel = null;
    this.lobbySpace = new LobbySpace(this.scene, this.physics, this.map.lobbyKit ?? null);
    this.placeAtSpawn(this.lobbySpace.spawn);
    this.lobbyFollowReady = false;
    if (this.lobby?.menuOpen) this.lobby.closeMenu();
  }

  /** 메뉴·시작 카드 표시 갱신 + 서버 시작 상태 반영 (주기적으로 호출, 바뀐 게 없으면 DOM 그대로) */
  private refreshMultiplayerMenu(): void {
    const s = this.net?.session;
    if (this.netGame && s?.inRoom) {
      this.applyNetMode();
      // 서버 매치 단계를 로컬 매치에 반영: 시작(카운트다운) / 종료(결과) / 대기실 복귀
      if (s.inMatch && this.match.state === 'WAITING') this.beginNetMatch();
      else if (s.matchPhase === 'result' && (this.match.state === 'COUNTDOWN' || this.match.state === 'PLAYING')) this.endNetMatch();
      else if (s.matchPhase === 'lobby' && this.match.state !== 'WAITING') this.resetNetMatch();
      // 서버가 확정한 결과 (모두 같은 값). 같은 결과는 한 번만 — 재접속·주기 갱신으로 다시 오면 그대로,
      // 다른 사람이 먼저 대기실로 가도 내 결과 화면은 직접 닫을 때까지 유지 (새 매치 시작 때 닫힘)
      if (s.matchPhase === 'result' && s.result && s.roomId) {
        const award = s.result.xp?.[s.me];
        if (award) this.setMyXp(award.after);
        this.resultScreen?.show(fromNetResult(s.result, s.me, s.roomId, this.nick));
      }
    }
    this.mpMenu?.refresh();
    this.hud.setMultiplayerCovered(!!this.mpMenu?.covering);
  }


  /** 첫 방 입장 성공: 봇 제거·멀티 테스트 규칙·테스트 HUD (싱글플레이 복귀는 새로고침) */
  private enterNetGame(): void {
    if (this.netGame) {
      this.resetNetMatch();
      return;
    }
    this.netGame = true;
    this.lobbyDone = true;
    // 로비 공간의 캐릭터는 방에 들어가지 않음: 입장 즉시 로비 공간을 치우고 경기장으로 (위치 패킷은 그 뒤부터)
    this.releaseLobbySpace();
    for (const b of this.bots.bots) {
      this.appearances.delete(b.id);
      this.teams.delete(b.id);
    }
    this.bots.removeAll();
    this.botsRemoved = true;
    this.resetNetMatch();
    this.applyNetMode();
    this.hud.setCharacter(this.avatar.character.id, true);
    this.hud.setModeLine('멀티플레이 (최대 8인) · 봇 없음');
    this.netHud = new NetTestHud(this.container, this.ensureNet().session, () => ({ hp: this.combatant.health.hp, max: this.combatant.health.maxHp }), () => this.fps);
    // 다른 플레이어 입장·퇴장·연결 끊김을 화면에 알림 (정식 HUD 알림)
    this.ensureNet().session.onNotice = (text) => this.hud.notify(text);
    this.refreshMultiplayerMenu();
  }

  /** 멀티 테스트 매치를 대기 상태로 새로 만듦 (입장·재입장·나간 뒤) */
  private resetNetMatch(): void {
    this.match = new Match(this.netRules(), {
      onStateChange: (state, prev) => this.onMatchState(state, prev),
      onFinish: (result) => this.onMatchFinish(result),
    });
    this.match.stats.register({ id: this.combatant.id, name: '나', isLocal: true });
    for (const r of this.net?.remotes.values() ?? []) this.match.stats.register({ id: r.id, name: r.name, isLocal: false });
    this.combatant.active = false;
    this.dead = false;
    this.deathTimer = 0;
    this.killedBy = null;
    this.combatant.health.reset(0);
    this.combatant.hitboxes.setEnabled(true);
    this.appearances.get(this.combatant.id)?.setDead(false);
    this.hud.clearKillFeed();
  }

  /**
   * 멀티 매치용 로컬 규칙: 표시 이름·카운트다운만 쓰고, 종료(시간·목표 킬)는 서버가 확정하므로 로컬 제한은 끔
   */
  private netRules(): MatchRules {
    const mode: NetMode = this.net?.session.mode ?? 'test';
    return {
      ...NET_TEST_RULES,
      label: NET_MODE_RULES[mode].label,
      hostility: mode === 'tdm' ? 'teams' : 'ffa',
      countdown: NET_TIMING.countdownMs / 1000,
      timeLimit: 1e6,
      scoreToWin: 1e6,
    };
  }

  /** 서버 모드·팀을 게임에 반영: 적대 규칙(TDM 아군 피해 없음), 팀 색(TDM만), 이름표 아군 표시. 바뀔 때만 */
  private applyNetMode(): void {
    const net = this.net;
    const s = net?.session;
    if (!net || !s) return;
    const tdm = s.mode === 'tdm';
    const me = s.players[s.me];
    const key = `${s.mode}|${Object.entries(s.players).map(([a, p]) => `${a}:${p.team ?? ''}`).join(',')}|${[...net.remotes.keys()].join(',')}`;
    if (key === this.netModeKey) return;
    this.netModeKey = key;
    COMBAT.hostility = tdm ? 'teams' : 'ffa';
    this.combatant.team = tdm && me?.team ? me.team : TEAMS.player;
    this.appearanceMode = tdm ? 'TDM' : 'FFA';
    this.teams.clear();
    if (tdm && me?.team) this.teams.set(this.combatant.id, me.team);
    for (const r of net.remotes.values()) {
      const t = s.players[r.account]?.team ?? null;
      // 캐릭터 이름(RED 등)과 팀은 별개: 팀은 서버 기록만 따름
      r.team = tdm && t ? t : `ffa:${r.account}`;
      if (tdm && t) this.teams.set(r.id, t);
      r.label.ally = tdm && !!t && t === me?.team;
    }
    for (const id of this.appearances.keys()) this.applyAppearance(id);
    if (this.match.state === 'WAITING') this.match = new Match(this.netRules(), {
      onStateChange: (state, prev) => this.onMatchState(state, prev),
      onFinish: (result) => this.onMatchFinish(result),
    });
    this.match.stats.register({ id: this.combatant.id, name: '나', isLocal: true });
    for (const r of net.remotes.values()) this.match.stats.register({ id: r.id, name: r.name, isLocal: false });
  }

  /** 서버 거부 사유 → 안내 문구 */
  private netReason(reason: string | undefined): string {
    const why: Record<string, string> = {
      not_host: '방장만 할 수 있어요',
      need_2_players: '두 명 이상 있어야 시작할 수 있어요',
      teams_unbalanced: '팀 인원 차이가 1명을 넘지 않게 상대 팀이 더 적을 때만 바꿀 수 있어요',
      in_progress: '매치가 진행 중이에요',
      team_full: '그 팀은 이미 4명이에요',
      not_tdm: '팀 데스매치에서만 팀을 바꿀 수 있어요',
    };
    return why[reason ?? ''] ?? reason ?? '알 수 없음';
  }

  /** 서버 매치 종료(결과) → 로컬 전투 정지, 결과 화면을 위해 포인터 잠금 해제 */
  private endNetMatch(): void {
    this.match.endExternally();
    this.hud.setMatchOver(true);
    this.aim.reset('death');
    this.weapons.cancelReaim();
    this.weapons.weapon.cancelReload();
    this.input.releaseLock();
  }

  /** 상단 점수판 (서버 값만 사용): TDM 팀 점수 / FFA 선두·내 킬 / 남은 시간 */
  private netScoreHud(): MatchHudInfo['net'] {
    const s = this.net?.session;
    if (!s) return undefined;
    const rule = NET_MODE_RULES[s.mode];
    const all = [...Object.entries(s.players).map(([a, p]) => ({ a, k: p.k, d: p.d })), ...Object.values(s.gone).map((g) => ({ a: g.account, k: g.k, d: g.d }))];
    const me = s.players[s.me];
    const sorted = [...all].sort((x, y) => y.k - x.k || x.d - y.d);
    // 결과가 나오면 종료 시각에서 멈춤
    const now = s.matchPhase === 'result' && s.result ? s.result.endedAt : s.serverNow();
    const timeLeft = s.endAt > 0 ? Math.max(0, Math.min(rule.timeLimitMs, s.endAt - Math.max(now, s.startAt)) / 1000) : null;
    return {
      mode: s.mode,
      blue: s.teamScore.BLUE,
      red: s.teamScore.RED,
      myTeam: me?.team ?? null,
      leader: sorted[0]?.k ?? 0,
      goal: rule.scoreToWin,
      mine: me?.k ?? 0,
      myDeaths: me?.d ?? 0,
      rank: Math.max(1, sorted.findIndex((x) => x.a === s.me) + 1),
      players: all.length,
      timeLeft,
    };
  }

  /**
   * 서버가 매치 시작(카운트다운)을 알림 → 스폰에서 카운트다운부터. 모든 화면이 서버 GO 시각(startAt)에 맞춰 시작.
   * TDM: 자기 팀 스폰 구역(BLUE = 남쪽, RED = 북쪽)에서 팀 안 순서대로, 리스폰도 자기 팀 구역. FFA·테스트: 자리별로 흩어져 시작
   */
  private beginNetMatch(): void {
    const s = this.net?.session;
    if (!s || this.match.state !== 'WAITING') return;
    this.sounds.ui('matchEnter');
    // 결과 화면을 보던 중 방장이 새 매치를 시작 → 결과를 닫고 경기장으로
    this.resultScreen?.close();
    this.hud.setMatchOver(false);
    this.applyNetMode();
    const { teamA, teamB } = this.map.spawns;
    const myTeam = s.players[s.me]?.team ?? null;
    if (s.mode === 'tdm' && myTeam) {
      const list = myTeam === 'BLUE' ? teamA : teamB;
      const mates = Object.entries(s.players)
        .filter(([, p]) => p.team === myTeam)
        .sort((a, b) => a[1].slot - b[1].slot);
      const idx = Math.max(0, mates.findIndex(([a]) => a === s.me));
      this.spawnPool = list;
      // 팀 안 순서별 스폰 (같은 쪽 진영, 서로 3m 이상): 기존 2인 자리(0·4) 그대로 + 3·4번째
      this.netSpawn = [list[0], list[4] ?? list[1], list[3] ?? list[2], list[2] ?? list[1]][idx] ?? list[0] ?? null;
    } else {
      this.spawnPool = [...teamA, ...teamB];
      // 자리별 스폰 (남·북 번갈아, 기존 4자리 그대로 + 5~8번째)
      const bySlot = [teamA[0], teamB[0], teamA[4] ?? teamA[1], teamB[3] ?? teamB[1], teamA[3] ?? teamA[2], teamB[4] ?? teamB[2], teamA[2], teamB[2]];
      this.netSpawn = bySlot[s.slot] ?? null;
    }
    this.beginMatch();
    // 서버 GO 시각에 맞춘 카운트다운 (늦게 받은 쪽은 그만큼 짧게, 이미 지났으면 바로 시작)
    this.match.countdownLeft = Math.max(0, (s.startAt - s.serverNow()) / 1000);
    s.client.addLog('info', `매치 시작 ${s.mode}${myTeam ? ` ${myTeam}팀` : ''} (자리 ${s.slot + 1}) · GO까지 ${this.match.countdownLeft.toFixed(1)}s`);
  }

  /** 네트워크 게임 모드 (처음 방 만들기/입장 때 생성) */
  private ensureNet(): NetGameMode {
    if (!this.net) this.initNet();
    return this.net!;
  }

  /** 네트워크 테스트 모드 준비: 게임 모드·디버그 패널(F9, 접힌 채) */
  private initNet(): void {
    const ctx: NetGameContext = {
      client: this.netClient,
      localId: this.combatant.id,
      physics: this.physics,
      camera: () => this.tpsCamera.camera,
      localState: () => this.netLocalState(),
      createAvatar: (id, character) => this.createRemoteAvatar(id, character),
      releaseAvatar: (avatar) => avatar.dispose(),
      forgetParticipant: (id) => {
        this.appearances.delete(id);
        this.teams.delete(id);
        this.feedDead.delete(id);
      },
      weaponModel: (wid) => this.weaponModels.get(WEAPONS[wid] ?? RIFLE),
      registerParticipant: (id, name) => this.match.stats.register({ id, name, isLocal: false }),
      setDeadLook: (id, dead) => this.appearances.get(id)?.setDead(dead),
      shotFx: (wid, from, end, kind, normal, shooterId, headshot, killed) => this.presentShotFx(wid, from, end, kind, normal, shooterId, headshot, killed),
      muzzleFx: (shooterId, wid, muzzle, dir, follow) => {
        const def = WEAPONS[wid] ?? RIFLE;
        this.effects.muzzleFlash(muzzle, follow, def.effects.flashScale);
        this.muzzlePop(muzzle, dir, wid, shooterId);
        this.audio.play(FIRE_SOUND[def.id] ?? 'fireRifle', { pos: muzzle, gain: MIX.otherGain, channel: 'otherFire' });
      },
      localHp: (hp, maxHp) => {
        const h = this.combatant.health;
        if (Math.abs(h.maxHp - maxHp) > 1e-6) h.setMaxHp(maxHp);
        h.hp = hp;
      },
      localDamaged: (source, amount) => {
        // 서버가 확정한 내 피해만 (스폰 보호 중 0 피해는 표시 안 함)
        if (amount > 0) this.tpsCamera.hurtKick(amount / 40);
        this.hud.showDamage(source, amount);
        if (amount > 0 && !this.dead) this.audio.play('hurt');
      },
      localKilled: (killer, hit, cause) => {
        if (this.dead) return;
        this.combatant.health.hp = 0;
        this.kill(killer, hit, cause);
      },
      isLocalDead: () => this.dead,
      remoteKilled: (id, killer, hit, cause) => {
        this.match.recordDeath(id, killer?.id ?? null);
        this.reportDeath(id, killer, hit, cause);
      },
      remoteRespawned: (id) => {
        this.queueSpawnFx(this.net?.avatarOf(id));
        this.feedDead.delete(id);
        this.match.respawned(id);
        this.applyAppearance(id);
      },
      // 멀티: 내 명중은 서버 확정 결과로만 히트마커·소리·피해 숫자 (예측 표시 없음, 결과 묶음당 한 번)
      confirmedHit: (headshot, killed, hits) => {
        if (this.lobbyShown) return;
        for (const h of hits) this.hud.damagePopup(h.at, h.damage, h.headshot);
        this.hitFeedback(headshot, killed);
      },
      roomInfo: () => this.refreshMultiplayerMenu(),
      leftRoom: (_reason, byUser) => {
        this.netLeftByUser = byUser;
        this.input.releaseLock();
        if (this.netGame) this.resetNetMatch();
        this.refreshMultiplayerMenu();
      },
    };
    this.net = new NetGameMode(ctx);
    this.net.session.nick = this.nick;
    // 자동 재접속 성공 → 같은 매치로 복귀 (서버가 자리·팀·기록을 되살림)
    this.net.session.onReconnected = () => {
      this.netLeftByUser = false;
      this.enterNetGame();
    };
    this.netPanel = new NetDebugPanel(this.container, this.net);
    if (import.meta.env.DEV) {
      // 서버 규칙(net/shared/protocol.ts)은 무기·캐릭터 설정의 사본 → 어긋나면 경고
      const issues = checkNetRules([...PRIMARY_WEAPONS, SECONDARY_WEAPON, MELEE_WEAPON], CHARACTERS);
      if (issues.length) console.warn('[net] 서버 규칙과 게임 설정이 다름:', issues);
    }
  }

  /** 봇 외형 (팀 마스크·사망 눈): 처음 만들 때와 다시 만들 때 공용 */
  private async setupBotAppearances(): Promise<void> {
    await Promise.all(
      this.bots.bots.map(async (b, i) => {
        const cid = this.botCharacterIds[i] ?? PLAYER_CHARACTER;
        const [mask, deadEyes] = await Promise.all([loadTeamMask(CHARACTERS[cid]), this.loadDeadEyesSafe(cid)]);
        // 그사이 다시 지워졌으면 버림
        if (!this.bots.bots.includes(b)) return;
        this.appearances.set(b.id, this.createAppearance(b.avatar.bodyMeshes, cid, mask, deadEyes));
        this.applyAppearance(b.id);
      }),
    );
  }

  /**
   * 멀티 매치 때 지운 봇을 다시 만듦 (새로고침 없이 연습전): 같은 이동 격자·스폰 규칙, 이름(BOT 1~3)·id 그대로라
   * 매치 등록·킬로그가 중복되지 않음. 외형은 비동기로 붙음 (불러오는 동안은 원래 색)
   */
  private rebuildBots(): void {
    this.bots.recreate();
    this.bots.hold = true;
    this.botsRemoved = false;
    void this.setupBotAppearances().catch((e) => console.warn('[bots] 외형을 다시 만들지 못함', e));
  }

  /** 원격 플레이어 아바타: 캐릭터 GLB 캐시 복제 + 팀 마스크·사망 눈 외형 (봇과 같은 구성) */
  private async createRemoteAvatar(id: string, character: CharacterId): Promise<PlayerAvatar> {
    // 아바타는 로비 원격 캐릭터와 같은 생성 경로 + 매치만 외형(팀 색·사망 눈) 등록
    const [avatar, mask, deadEyes] = await Promise.all([this.createLobbyAvatar(character), loadTeamMask(CHARACTERS[character]), this.loadDeadEyesSafe(character)]);
    this.appearances.set(id, this.createAppearance(avatar.bodyMeshes, character, mask, deadEyes));
    this.applyAppearance(id);
    return avatar;
  }

  /** 서버에 리스폰 요청 (승인되면 로컬 리스폰, 아니면 잠시 뒤 다시) */
  private requestNetRespawn(): void {
    if (this.netRespawnPending || !this.net) return;
    this.netRespawnPending = true;
    void this.net.requestRespawn().then(({ ok, prot }) => {
      this.netRespawnPending = false;
      if (ok && this.dead) {
        if (prot !== undefined) this.netProtEnd = prot;
        this.respawn();
        this.syncNetProtection(true);
      } else if (!ok) this.deathTimer = 0.25;
    });
  }

  /** 멀티: 로컬 리스폰 보호를 서버 보호 끝 시각에 맞춤 (net/spawnProtection.ts). 낙사 부활 뒤 응답 전에는 로컬 보호 그대로 */
  private syncNetProtection(atRespawn = false): void {
    const s = this.net?.session;
    if (!s?.inRoom || this.dead || this.netProtAwait) return;
    const h = this.combatant.health;
    h.protection = syncedProtection(h.protection, s.players[s.me]?.prot ?? 0, this.netProtEnd, s.serverNow(), COMBAT.player.spawnProtection, atRespawn);
  }

  /** 상태 패킷용 로컬 값 (이번 프레임 최종 자세) */
  private netLocalState(): LocalState {
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const p = this.player;
    const f = this.renderFeet;
    const v = p.velocity;
    const a = this.aimDir;
    const prof = this.aim.currentProfile;
    return {
      p: [r3(f.x), r3(f.y), r3(f.z)],
      v: [r2(v.x), r2(v.y), r2(v.z)],
      y: r3(this.bodyYaw),
      a: [r3(a.x), r3(a.y), r3(a.z)],
      pi: r3(this.netPitch),
      m: Math.max(0, NET_MODES.indexOf(p.mode)),
      f: (p.grounded ? 1 : 0) | (p.sprinting && p.grounded ? 2 : 0) | (this.netStrafing ? 4 : 0) | (this.dead ? 8 : 0),
      w: this.weapons.def.id,
      c: this.avatar.character.id,
      rl: r2(this.weapons.reloadProgress),
      ms: r2(this.weapons.swingProgress),
      bp: r2(this.weapons.boltProgress),
      ads: r2(this.aim.blend),
      k: r3(this.weapons.kick * (prof ? THREE.MathUtils.lerp(1, prof.kickScale, this.aim.blend) : 1)),
    };
  }

  /** 디버그 (콘솔): 네트워크 테스트 모드 */
  get netMode(): NetGameMode | null {
    return this.net;
  }

  private updateFps(dt: number): void {
    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.fps = this.fpsFrames / this.fpsTime;
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }
  }

  private resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.tpsCamera?.setAspect(w / Math.max(1, h));
    this.resultScreen?.resize(w, h);
  }

  dispose(): void {
    // HMR 등으로 두 번 불려도 해제된 Rapier 월드를 다시 건드리지 않게
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.abort.abort();
    this.hub?.dispose();
    this.peers?.dispose();
    this.lobbySpace?.dispose();
    this.lobby?.dispose();
    this.pauseMenu?.dispose();
    // 네트워크 먼저 (룸 나가기·원격 아바타 해제) → 그다음 장면 전체 해제
    this.netPanel?.dispose();
    this.netHud?.dispose();
    this.mpMenu?.dispose();
    this.resultScreen?.dispose();
    this.net?.dispose();
    this.timer.dispose();
    this.resizeObserver.disconnect();
    this.input.dispose();
    this.sounds.dispose();
    this.audio.dispose();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
          m.dispose();
        }
      }
    });
    this.targets.forEach((t) => t.dispose());
    this.bots?.dispose();
    this.occlusion?.dispose();
    this.weaponArt?.dispose();
    this.weaponModels?.dispose();
    this.effects?.dispose();
    this.bullets?.dispose();
    this.tracers?.dispose();
    this.avatar?.dispose();
    this.map?.dispose();
    this.characterDebug?.dispose();
    this.debugPanel?.dispose();
    this.muzzleDebug?.dispose();
    this.shotDebug?.dispose();
    this.hud.dispose();
    this.physics?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
