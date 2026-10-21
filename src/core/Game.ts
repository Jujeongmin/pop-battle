import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadCharacterModel, loadGameAssets, type LoadedModel } from '../assets/loadAssets';
import { WeaponModelLibrary } from '../assets/weaponModels';
import type { Bot } from '../bots/Bot';
import { BotManager } from '../bots/BotManager';
import { BOT } from '../config/bots';
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
  CHARACTER_IDS,
  CHARACTER_SELECT,
  CHARACTERS,
  isCharacterSelectable,
  KILL_FEED_COLORS,
  KILL_FEED_TEAM_COLORS,
  PLAYER_CHARACTER,
  saveCharacter,
  TEAM_PREVIEW,
  type CharacterId,
  type GameModeId,
  type TeamId,
} from '../config/characters';
import { CharacterAppearance, loadDeadEyes, loadTeamMask, type DeadEyes, type Expression } from '../player/CharacterAppearance';
import { Match, type MatchResult, type MatchState } from '../match/Match';
import { LocalPlayerOcclusion } from '../camera/LocalPlayerOcclusion';
import { TpsCamera } from '../camera/TpsCamera';
import { MuzzleDebug } from '../combat/MuzzleDebug';
import { ShotPathDebug } from '../combat/ShotPathDebug';
import { AimController } from '../combat/AimController';
import { WeaponEffects } from '../combat/WeaponEffects';
import { ToyBullets } from '../combat/ToyBullets';
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
import { CHARACTER, MOVEMENT, RENDER } from '../config/gameConfig';
import { MELEE_MOUNT, MELEE_WEAPON, PRIMARY_WEAPONS, RIFLE, RIFLE_MOUNT, SECONDARY_WEAPON, WEAPONS, type WeaponDef } from '../config/weapons';
import { initRapier, Physics } from '../physics/Physics';
import type { AttackerInfo, Damageable, HitInfo } from '../physics/Physics';
import { PlayerAvatar } from '../player/PlayerAvatar';
import { PlayerCombatant } from '../player/PlayerCombatant';
import { PlayerController } from '../player/PlayerController';
import { CharacterDebug, type DebugParticipant } from '../ui/CharacterDebug';
import { DebugPanel } from '../ui/DebugPanel';
import type { DeathCause, KillFeedEvent } from '../ui/KillFeed';
import { Hud, type MatchHudInfo } from '../ui/Hud';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MAP_ID } from '../config/maps';
import type { GameMap, SpawnPoint } from '../world/GameMap';
import { ArenaMap } from '../world/maps/ArenaMap';
import { TestMap } from '../world/TestMap';
import { TestTarget } from '../world/TestTarget';
import { GameInput } from './GameInput';
import { JoystickAutoSprint } from './JoystickAutoSprint';

/** 새로고침 뒤 메뉴에 "이전 방 다시 입장"을 보이기 위한 마지막 룸 (NetSession과 같은 키, 탭 단위) */
function readLastRoomCode(): string | null {
  try {
    return sessionStorage.getItem('popbattle.lastRoom');
  } catch {
    return null;
  }
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

function dampAngle(current: number, target: number, sharpness: number, dt: number): number {
  const diff = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + diff * (1 - Math.exp(-sharpness * dt));
}

/** 게임 조립과 메인 루프. 각 모듈의 업데이트 순서를 여기서만 관리한다. */
export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly timer = new THREE.Timer();
  /** 키보드·마우스 + 모바일 터치 (같은 InputState로 합침) */
  private readonly input: GameInput;
  private readonly hud: Hud;
  private readonly audio = new AudioManager();
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
  private debugPanel!: DebugPanel;
  /** 개발용 총구 표시 (개발 서버에서만 생성, 기본 꺼짐) */
  private muzzleDebug: MuzzleDebug | null = null;
  private shotDebug: ShotPathDebug | null = null;
  /** 이번 프레임 총구 방향 (월드) */
  private readonly muzzleDir = new THREE.Vector3();
  private targets: TestTarget[] = [];
  private combatant!: PlayerCombatant;
  private bots!: BotManager;
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
  /** 킬로그에 이미 올린 사망 (참가자 id, 리스폰하면 지움) → 같은 사망이 두 번 올라가지 않게 */
  private readonly feedDead = new Set<string>();
  /** 시작 화면 캐릭터 선택 순번 (불러오는 중 여러 번 누르면 마지막만 반영) */
  private characterSelectToken = 0;
  /** 플레이어 총구 위치 (매 프레임 갱신, 총구 화염이 따라감) */
  private readonly muzzle = new THREE.Vector3();
  private killedBy: string | null = null;
  private weaponModels!: WeaponModelLibrary;
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
  /** 멀티 테스트 게임으로 전환됨 (봇 제거, 최대 4인 규칙). 싱글플레이로 돌아가려면 새로고침 */
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

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, RENDER.maxPixelRatio));
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
    this.input.onTouchModeChange = (on) => this.hud.setTouchMode(on);
    this.hud.onSlotTap = (i) => this.input.touch.pressSlot(i + 1);
    this.hud.onTouchSettings = () => this.input.touch.openSettings();
    this.hud.onTouchStart = () => this.input.requestLock();
    this.input.onLockChange = (locked) => {
      this.hud.setLocked(locked);
      // 브라우저 자동 재생 정책: 사용자 클릭(포인터 잠금) 뒤에 오디오 시작
      if (locked) {
        this.audio.unlock();
        this.startMatch();
      }
    };
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
    this.characterModels.set(PLAYER_CHARACTER, Promise.resolve(assets.character));
    for (const [id, m] of assets.otherCharacters) this.characterModels.set(id, Promise.resolve(m));
    const botSources = {
      characters: botCharacterIds.map((id) => ({ id, ...(id === PLAYER_CHARACTER ? assets.character : assets.otherCharacters.get(id)!) })),
      rifle: assets.rifle.scene.clone(true),
    };
    // 무기 모델: GLB가 있으면 GLB, 없으면 임시 도형 (무기당 1회 생성 후 재사용)
    this.weaponModels = new WeaponModelLibrary(new Map([[RIFLE.id, assets.rifle.scene], ...assets.weapons]));
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
    // 판정(WeaponSystem)은 결과만 내보내고, 연출(이펙트·사운드·HUD)은 여기서 결과를 보고 처리
    this.weapons = new WeaponSystem(RIFLE, this.physics, this.aim, this.player.body, () => this.combatant.attacker(this.muzzle), {
      onFire: (muzzle, def) => {
        this.effects.muzzleFlash(muzzle, this.muzzle, def.effects.flashScale);
        this.muzzlePop(muzzle, this.muzzleDir, def.id, this.combatant.id);
        this.muzzleDebug?.onFlash(muzzle, this.muzzle);
        this.audio.play('fire', { gain: def.effects.fireGain, pitch: def.effects.firePitch });
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
      onRecoil: (p, y, ratio, sharp) => this.tpsCamera.addRecoil(p, y, ratio, sharp),
    });

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
        this.audio.play('fire', { gain: this.botSoundGain(muzzle) * 0.75, channel: 'botFire' });
      },
      onShot: (_bot, r) => this.presentShot(r),
      onReload: (bot, phase) =>
        this.audio.play(phase === 'start' ? 'reloadStart' : 'reloadEnd', { gain: this.botSoundGain(bot.muzzle) * 0.6, channel: 'botReload' }),
      // 킬·데스 집계 (PLAYING에서만, 한 번의 사망에 한 번)
      onDeath: (bot, killer, hit) => {
        this.match.recordDeath(bot.id, killer?.id ?? null);
        this.reportDeath(bot.id, killer, hit, 'weapon');
        // 사망 표정 (사망 애니메이션과 같은 프레임부터, 리스폰 전까지 유지)
        this.appearances.get(bot.id)?.setDead(true);
      },
      onRespawn: (bot) => {
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
    this.hud.onReplay = () => this.replay();

    // 외형: 캐릭터별 팀 마스크(캐릭터당 1장) + 인스턴스별 머티리얼 패치. FFA는 원래 색
    onProgress('캐릭터 외형…');
    const characterOf = new Map<string, CharacterId>([[this.combatant.id, PLAYER_CHARACTER]]);
    this.bots.bots.forEach((b, i) => characterOf.set(b.id, botCharacterIds[i]!));
    for (const [id, cid] of characterOf) {
      const [mask, deadEyes] = await Promise.all([loadTeamMask(CHARACTERS[cid]), this.loadDeadEyesSafe(cid)]);
      const avatar = id === this.combatant.id ? this.avatar : this.bots.bots.find((b) => b.id === id)!.avatar;
      this.appearances.set(id, new CharacterAppearance(avatar.bodyMeshes, cid, mask, deadEyes));
    }
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
        return { id, name: c.name, role: sel.role, color: sel.color, maxHp: c.stats.maxHp, speed: c.stats.speed, hitSize: c.stats.hitSize, locked: sel.locked, selectable: isCharacterSelectable(id) };
      }),
      (id) => void this.selectCharacter(id as CharacterId),
    );
    this.hud.setCharacter(this.avatar.character.id, false);
    this.hud.setLoadoutOptions(PRIMARY_WEAPONS.map((w) => ({ id: w.id, name: w.name })), (id) => this.selectPrimary(id));
    this.hud.setLoadout(this.primary.id, false);

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
    this.renderer.render(this.scene, this.tpsCamera.camera);
  };

  private update(dt: number): void {
    this.input.beginFrame();
    const input = this.input.state;
    this.updateFps(dt);

    // 무기 장착 디버그 패널은 개발 모드에서만
    if (input.debugTogglePressed && import.meta.env.DEV) {
      if (this.debugPanel.toggle()) this.input.releaseLock();
    }

    // --- 시점 (렌더 프레임마다 즉시 반영) ---
    this.tpsCamera.applyLook(input.lookDX, input.lookDY, this.aim.lookSensitivityMultiplier);

    // --- 매치 진행 (카운트다운·타이머·시간 종료) ---
    this.match.update(dt);
    const combatActive = this.match.combatActive;
    // 대기·카운트다운·종료 중에는 봇도 제자리 (종료 후에는 쓰러진 봇도 부활하지 않음)
    this.bots.hold = !combatActive;
    this.bots.respawnEnabled = this.match.respawnAllowed;
    // 원격 플레이어: 보간 위치·자세·판정을 물리 스텝 전에 맞춤 (이번 프레임 사격 판정에 반영)
    this.net?.updateRemotes(dt);

    // --- 사망/리스폰 ---
    this.combatant.update(dt);
    if (input.suicidePressed && !this.dead && combatActive) this.kill(null, null, 'suicide');
    if (this.dead && this.match.respawnAllowed) {
      this.deathTimer -= dt;
      if (this.deathTimer <= 0) {
        if (this.net?.session.inRoom) this.requestNetRespawn();
        else this.respawn();
      }
    }
    if (this.player.position.y < MOVEMENT.killPlaneY) {
      // 낙사: 공격자 없는 사망으로 집계 (데스만) 후 바로 부활
      if (!this.dead) {
        this.match.recordDeath(this.combatant.id, null);
        this.reportDeath(this.combatant.id, null, null, 'fall');
        // 네트워크: 서버에 낙사(바로 부활 가능) → 리스폰 승인 (일반 호출은 보낸 순서대로 실행)
        this.net?.selfDeath('fall');
        if (this.net?.session.inRoom) void this.net.requestRespawn();
      }
      this.respawn();
    }

    // 이동·사격·무기 교체는 전투 중(PLAYING)에만
    const canAct = !this.dead && this.input.isLocked && combatActive;
    // --- 무기 교체: 숫자키 1·2·3, 휠은 세 슬롯 순환 ---
    if (canAct && input.slotPressed > 0) this.switchSlot(input.slotPressed - 1);
    if (canAct && input.wheelSteps !== 0) {
      const n = this.loadout.length;
      this.switchSlot((((this.slotIndex + input.wheelSteps) % n) + n) % n);
    }

    // --- 이동 (고정 스텝) ---
    // 달리기 의도: PC는 입력(W 더블 탭)이 정함, 모바일은 조이스틱 전방 유지 시간으로 판정. 이후 이동·애니메이션·ADS 해제는 같은 경로
    const sprintIntent =
      canAct && (input.moveSource === 'joystick' ? this.autoSprint.update(dt, input.moveX, input.moveY, this.player.isSliding) : input.sprint);
    if (!canAct) this.autoSprint.reset();
    if (canAct && input.jumpPressed) this.player.queueJump();
    if (canAct && input.slidePressed) this.player.queueSlide();
    const step = RENDER.fixedStep;
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= step && steps < RENDER.maxSubSteps) {
      this.player.step(step, {
        moveX: canAct ? input.moveX : 0,
        moveY: canAct ? input.moveY : 0,
        cameraYaw: this.tpsCamera.yaw,
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
    if (canAct && input.aimTogglePressed && this.weapons.ready) {
      // 볼트액션 중 자동 재조준이 예약돼 있으면 우클릭 = 예약 취소 (조준하지 않음). 아니면 기존 토글
      if (this.weapons.reaimPending) this.weapons.cancelReaim();
      else this.aim.toggle();
    }
    this.aim.update(dt);

    // --- 몸 방향 ---
    const vel = this.player.velocity;
    const speed = Math.hypot(vel.x, vel.z);
    const combatFacing = !this.dead && (this.aim.isAiming || this.weapons.timeSinceShot < 0.7 || input.fireHeld);
    // 총기 전투 자세(조준·사격 중): 총이 보이게 몸을 조준 방향보다 오른쪽으로 비틂 (기존). 근접무기는 비틀지 않음
    const bodyCombatFacing = combatFacing && !this.weapons.isMelee;
    // 몸(루트) 방향 = 카메라 수평 회전(yaw)만. 피치는 루트에 넣지 않음 (상체 숙임은 applySpinePitch, 전투 중만).
    // 이동 방향을 보려고 따로 돌지 않음 → WASD는 카메라 기준 그대로, 다리는 골반 비틀기·뒤로 걷기로 이동 방향 표현.
    // 카메라는 몸 방향을 읽지 않아(발 위치만 따라감) 회전 피드백 루프 없음.
    const strafing = !this.player.isSliding;
    let targetYaw = this.tpsCamera.yaw + Math.PI;
    if (this.player.isSliding && speed > 0.5) targetYaw = Math.atan2(vel.x, vel.z);
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
        const muzzleDir = aimPoint.clone().sub(this.lastMuzzle);
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
      reloadPressed: input.reloadPressed,
      canAct,
      camera: cam,
      pivot: chest.clone(),
      muzzle,
      chest: chest.clone(),
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
    this.characterDebug?.update(dt, this.debugPanel.visible);
    this.bullets.update(dt);
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
    this.netPanel?.update(dt);
    // 멀티 측정 패널: F9 네트워크 디버그를 열었을 때만 (정식 HUD와 겹치지 않게)
    this.netHud?.update(dt, this.netGame && !!this.netPanel?.isOpen);
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
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const origin = cam.position.clone().addScaledVector(dir, Math.max(0, chest.clone().sub(cam.position).dot(dir)));
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
              this.audio.play('impact', byPlayer ? undefined : { gain: this.botSoundGain(at), channel: 'botImpact' });
            };
    }
    this.bullets.fire(weaponId, from, end, arrive, color);
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
    this.hud.showHit(head, killed);
    this.audio.play('hit'); // 헤드샷도 같은 소리
    if (killed) this.audio.play('kill');
  }

  /** 근접 판정 결과 연출 (헤드샷 표시 없음) */
  private presentMelee(r: MeleeResult): void {
    let killed = false;
    for (const h of r.hits) {
      this.effects.enemyHit(h.point, h.normal, false, h.killed);
      this.hud.damagePopup(h.point, h.damage, false);
      killed ||= h.killed;
    }
    if (r.hits.length > 0) {
      this.hud.showHit(false, killed);
      this.audio.play('hit');
      if (killed) this.audio.play('kill');
    } else if (r.wall) {
      this.effects.worldImpact(r.wall.point, r.wall.normal);
      this.audio.play('impact');
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
    this.slotIndex = index;
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
    if (ok) saveCharacter(id);
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
    const appearance = new CharacterAppearance(avatar.bodyMeshes, id, mask, deadEyes);
    // 교체해도 지금 생사·디버그 표정 고정은 이어감
    appearance.setDead(who === this.combatant.id ? this.dead : !(this.bots.bots.find((b) => b.id === who)?.alive ?? true));
    appearance.setExpressionOverride(prevExpr);
    this.appearances.set(who, appearance);
    this.applyAppearance(who);
    return true;
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

  selectPrimary(id: string): boolean {
    if (this.combatant.active) return false;
    const def = PRIMARY_WEAPONS.find((w) => w.id === id);
    if (!def) return false;
    this.primary = def;
    this.hud.setLoadout(def.id, false);
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

  /** 봇 효과음 거리 감쇠 (카메라 기준) */
  private botSoundGain(pos: THREE.Vector3): number {
    const d = this.tpsCamera.camera.position.distanceTo(pos);
    return THREE.MathUtils.clamp(1 - d / BOT.soundFalloff, 0, 1) ** 1.5 * 0.9 + 0.1 * (d < BOT.soundFalloff ? 1 : 0);
  }

  /** 플레이어 피격: 피해 방향·섬광, 체력 0이면 사망 */
  private onPlayerDamaged(hit: HitInfo, applied: number): void {
    this.hud.showDamage(hit.attacker?.position ?? null, applied);
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
    this.combatant.active = true;
    // 주무기 고정 (매치 중 변경 불가)
    this.hud.setLoadout(this.primary.id, true);
    this.hud.setCharacter(this.avatar.character.id, true);
    this.match.startCountdown();
    this.dead = false;
    this.deathTimer = 0;
    this.respawn();
    // 매치 시작은 카운트다운 동안 모두 정지 → 시작 보호 없음
    this.combatant.health.protection = 0;
    this.bots.resetForMatch();
    for (const id of this.appearances.keys()) this.applyAppearance(id);
    this.hud.hideResult();
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
    // 버튼 클릭(사용자 동작) 안에서 포인터 잠금 요청 → 바로 조작 가능
    this.input.requestLock();
    this.beginMatch();
  }

  private onMatchState(state: MatchState, _prev: MatchState): void {
    if (state === 'PLAYING') this.hud.flashGo();
  }

  /** 매치 종료 (한 번만): 전투 정지, 조준·재장전 해제, 결과 화면 (포인터 잠금 해제 → 버튼 클릭 가능) */
  private onMatchFinish(result: MatchResult): void {
    this.aim.reset('death');
    this.weapons.cancelReaim();
    this.weapons.weapon.cancelReload();
    this.hud.showResult(result, this.match.rules);
    this.input.releaseLock();
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
    this.killedBy = killer?.name ?? null;
    this.match.recordDeath(this.combatant.id, killer?.id ?? null);
    this.combatant.health.kill();
    // 쓰러진 플레이어는 사격 판정 제외 (이동 캡슐은 바닥 충돌용으로 유지)
    this.combatant.hitboxes.setEnabled(false);
    this.dead = true;
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

  private respawn(): void {
    this.dead = false;
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
      netGame: () => this.netGame,
      leftUnexpectedly: () => this.netGame && !this.netLeftByUser && !this.net?.session.inRoom && !!this.net?.session.lastError,
      locked: () => this.input.isLocked,
      matchStarted: () => this.match.state !== 'WAITING',
      localTeam: () => this.net?.session.players[this.net.session.me]?.team ?? null,
      create: async (mode) => {
        const net = this.ensureNet();
        net.session.cancelReconnect();
        this.netLeftByUser = false;
        if (await net.session.createRoom(this.avatar.character.id, mode)) this.enterNetGame();
      },
      setMode: async (mode) => {
        const r = await this.ensureNet().session.setMode(mode);
        if (!r.ok) this.mpMenu?.setNotice(`모드 변경 실패: ${this.netReason(r.reason)}`);
      },
      switchTeam: async () => {
        const r = await this.ensureNet().session.switchTeam();
        if (!r.ok) this.mpMenu?.setNotice(`팀 변경 실패: ${this.netReason(r.reason)}`);
      },
      toLobby: async () => {
        await this.ensureNet().session.toLobby();
      },
      join: async (code) => {
        const net = this.ensureNet();
        net.session.cancelReconnect();
        this.netLeftByUser = false;
        if (await net.session.joinByCode(this.avatar.character.id, code)) this.enterNetGame();
      },
      rejoin: async () => {
        const net = this.ensureNet();
        net.session.cancelReconnect();
        this.netLeftByUser = false;
        if (await net.session.rejoin(this.avatar.character.id)) this.enterNetGame();
      },
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
      singlePlayer: () => this.reloadPage(false),
    });
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
    }
    this.mpMenu?.refresh();
    this.hud.setMultiplayerCovered(!!this.mpMenu?.covering);
  }

  /** 새로고침 (싱글플레이로 돌아가기 / 멀티 메뉴 다시 열기). Verse8이 붙인 주소 파라미터(account·auth 등)는 유지 */
  private reloadPage(multiplayer: boolean): void {
    const url = new URL(location.href);
    if (multiplayer) url.searchParams.set('net', '1');
    else url.searchParams.delete('net');
    location.replace(url.toString());
  }

  /** 첫 방 입장 성공: 봇 제거·멀티 테스트 규칙·테스트 HUD (싱글플레이 복귀는 새로고침) */
  private enterNetGame(): void {
    if (this.netGame) {
      this.resetNetMatch();
      return;
    }
    this.netGame = true;
    for (const b of this.bots.bots) {
      this.appearances.delete(b.id);
      this.teams.delete(b.id);
    }
    this.bots.removeAll();
    this.resetNetMatch();
    this.applyNetMode();
    this.hud.setCharacter(this.avatar.character.id, true);
    this.hud.setModeLine('멀티플레이 (최대 4인) · 봇 없음');
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
      need_4_players: '4명이 모두 들어와야 시작할 수 있어요',
      teams_unbalanced: '팀 인원을 2:2로 맞춰 주세요',
      in_progress: '매치가 진행 중이에요',
      team_full: '그 팀은 이미 2명이에요',
      not_tdm: '팀 데스매치에서만 팀을 바꿀 수 있어요',
    };
    return why[reason ?? ''] ?? reason ?? '알 수 없음';
  }

  /** 서버 매치 종료(결과) → 로컬 전투 정지, 결과 화면을 위해 포인터 잠금 해제 */
  private endNetMatch(): void {
    this.match.endExternally();
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
      this.netSpawn = [list[0], list[4] ?? list[1]][idx] ?? list[0] ?? null;
    } else {
      this.spawnPool = [...teamA, ...teamB];
      const bySlot = [teamA[0], teamB[0], teamA[4] ?? teamA[1], teamB[3] ?? teamB[1]];
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
        this.audio.play('fire', { gain: this.botSoundGain(muzzle) * def.effects.fireGain, pitch: def.effects.firePitch, channel: 'botFire' });
      },
      localHp: (hp, maxHp) => {
        const h = this.combatant.health;
        if (Math.abs(h.maxHp - maxHp) > 1e-6) h.setMaxHp(maxHp);
        h.hp = hp;
      },
      localDamaged: (source, amount) => this.hud.showDamage(source, amount),
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
        this.feedDead.delete(id);
        this.match.respawned(id);
        this.applyAppearance(id);
      },
      confirmedKill: () => {
        this.hud.showHit(false, true);
        this.audio.play('kill');
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

  /** 원격 플레이어 아바타: 캐릭터 GLB 캐시 복제 + 팀 마스크·사망 눈 외형 (봇과 같은 구성) */
  private async createRemoteAvatar(id: string, character: CharacterId): Promise<PlayerAvatar> {
    const [model, mask, deadEyes] = await Promise.all([this.loadCharacter(character), loadTeamMask(CHARACTERS[character]), this.loadDeadEyesSafe(character)]);
    const avatar = new PlayerAvatar(SkeletonUtils.clone(model.scene), model.clips, this.weaponModels.get(RIFLE).clone(true), RIFLE_MOUNT, character);
    this.scene.add(avatar.root);
    this.appearances.set(id, new CharacterAppearance(avatar.bodyMeshes, character, mask, deadEyes));
    this.applyAppearance(id);
    return avatar;
  }

  /** 서버에 리스폰 요청 (승인되면 로컬 리스폰, 아니면 잠시 뒤 다시) */
  private requestNetRespawn(): void {
    if (this.netRespawnPending || !this.net) return;
    this.netRespawnPending = true;
    void this.net.requestRespawn().then((ok) => {
      this.netRespawnPending = false;
      if (ok && this.dead) this.respawn();
      else if (!ok) this.deathTimer = 0.25;
    });
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
  }

  dispose(): void {
    // HMR 등으로 두 번 불려도 해제된 Rapier 월드를 다시 건드리지 않게
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    // 네트워크 먼저 (룸 나가기·원격 아바타 해제) → 그다음 장면 전체 해제
    this.netPanel?.dispose();
    this.netHud?.dispose();
    this.mpMenu?.dispose();
    this.net?.dispose();
    this.timer.dispose();
    this.resizeObserver.disconnect();
    this.input.dispose();
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
    this.weaponModels?.dispose();
    this.effects?.dispose();
    this.bullets?.dispose();
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
