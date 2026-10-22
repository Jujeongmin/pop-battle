// 온라인 로비: 같은 로비 사람들의 캐릭터 그리기 (LobbyHub가 준 보간 버퍼 → 아바타 자세).
// 매치용 RemotePlayer와 달리 이동 캡슐·피격 판정이 없음 → 서로 밀거나 막지 않고, 공격·피해도 없다.
// 머리 위에는 닉네임만 (textContent, HTML 해석 없음). 계정·캐릭터 id는 화면에 내지 않음.
import * as THREE from 'three';
import type { CharacterId } from '../config/characters';
import type { PlayerAvatar } from '../player/PlayerAvatar';
import type { HubPeer } from './LobbyHub';
import { poseRemoteAvatar } from './remotePose';
import { HUB_TIMING, NET_CHARACTER_HP } from './shared/protocol';

export interface LobbyPeersContext {
  /** 아바타 만들기 (GLB 캐시 복제·장면 추가까지) */
  createAvatar(character: CharacterId): Promise<PlayerAvatar>;
  /** 아바타 해제 (장면 제거·리소스 해제) */
  releaseAvatar(avatar: PlayerAvatar): void;
  camera(): THREE.Camera;
  /** 이름표를 붙일 화면 요소 */
  readonly container: HTMLElement;
  /** 저사양(터치 기기): 원격 캐릭터 그림자 끔 */
  lowPower(): boolean;
}

interface Item {
  peer: HubPeer;
  avatar: PlayerAvatar | null;
  /** 지금 아바타 캐릭터 / 만드는 중인 캐릭터 */
  char: string;
  loading: string | null;
  tag: HTMLDivElement;
  lastQ: number;
  /** 멀리 있으면 몇 프레임에 한 번만 자세 갱신 (밀린 시간은 모아서) */
  skip: number;
  pendingDt: number;
}

/** 이 거리 밖은 그리지 않음 / 이 거리 밖은 3프레임에 한 번 갱신 / 이름표 보이는 거리 (m) */
const HIDE_DIST = 70;
const SLOW_DIST = 30;
const TAG_DIST = 38;

const _v = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _feet = new THREE.Vector3();

export class LobbyPeers {
  private readonly items = new Map<string, Item>();
  private readonly layer = document.createElement('div');
  private disposed = false;

  constructor(private readonly ctx: LobbyPeersContext) {
    this.layer.className = 'lobby-nametags';
    ctx.container.appendChild(this.layer);
  }

  get size(): number {
    return this.items.size;
  }

  add(peer: HubPeer): void {
    if (this.items.has(peer.account)) return;
    const tag = document.createElement('div');
    tag.className = 'lobby-nametag';
    tag.textContent = peer.nick || '플레이어';
    tag.style.display = 'none';
    this.layer.appendChild(tag);
    const item: Item = { peer, avatar: null, char: '', loading: null, tag, lastQ: -1, skip: 0, pendingDt: 0 };
    this.items.set(peer.account, item);
    this.ensureAvatar(item);
  }

  /** 닉네임·캐릭터 변경 */
  change(peer: HubPeer): void {
    const item = this.items.get(peer.account);
    if (!item) return;
    item.tag.textContent = peer.nick || '플레이어';
    this.ensureAvatar(item);
  }

  remove(account: string): void {
    const item = this.items.get(account);
    if (!item) return;
    this.items.delete(account);
    item.tag.remove();
    if (item.avatar) this.ctx.releaseAvatar(item.avatar);
    item.avatar = null;
  }

  clear(): void {
    for (const acc of [...this.items.keys()]) this.remove(acc);
  }

  /** 보간 지연만큼 늦은 시점의 상태로 자세·위치·이름표 갱신 */
  update(dt: number): void {
    if (this.items.size === 0) return;
    const cam = this.ctx.camera() as THREE.PerspectiveCamera;
    const renderTime = performance.now() - HUB_TIMING.interpDelayMs;
    const w = this.ctx.container.clientWidth;
    const h = this.ctx.container.clientHeight;
    for (const item of this.items.values()) {
      const a = item.avatar;
      const s = item.peer.buffer.sample(renderTime);
      if (!a || !s) {
        item.tag.style.display = 'none';
        continue;
      }
      _feet.set(s.p[0], s.p[1], s.p[2]);
      const dist = cam.position.distanceTo(_feet);
      a.root.visible = dist < HIDE_DIST;
      if (!a.root.visible) {
        item.tag.style.display = 'none';
        continue;
      }
      item.pendingDt += dt;
      if (dist > SLOW_DIST && ++item.skip % 3 !== 0) {
        this.placeTag(item, a, cam, w, h, dist);
        continue;
      }
      // 점프·착지는 그 패킷을 처음 그릴 때만. 자세는 매치 원격 플레이어와 같은 코드 (로비 패킷은 전투 값이 0)
      const fresh = s.near.q !== item.lastQ;
      item.lastQ = s.near.q;
      poseRemoteAvatar(a, s, Math.min(item.pendingDt, 0.1), fresh, { feet: _feet, velocity: _vel, aimDir: _aim });
      item.pendingDt = 0;
      this.placeTag(item, a, cam, w, h, dist);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
    this.layer.remove();
  }

  /** 캐릭터가 다르면 새 아바타를 만들고 이전 것은 해제 (늦게 끝난 이전 요청은 버림) */
  private ensureAvatar(item: Item): void {
    const want = item.peer.char in NET_CHARACTER_HP ? item.peer.char : 'blue';
    if (item.char === want || item.loading === want) return;
    item.loading = want;
    this.ctx
      .createAvatar(want as CharacterId)
      .then((avatar) => {
        // 그사이 나갔거나 다른 캐릭터로 바뀜
        if (this.disposed || this.items.get(item.peer.account) !== item || item.loading !== want) {
          this.ctx.releaseAvatar(avatar);
          return;
        }
        if (this.ctx.lowPower()) avatar.root.traverse((o) => (o.castShadow = false));
        // 로비에서는 무기를 쓰지 않음 → 원격 캐릭터 라이플은 숨김 (1명당 약 7천 삼각형·그리기 호출 절약)
        avatar.rifle.visible = false;
        if (item.avatar) this.ctx.releaseAvatar(item.avatar);
        item.avatar = avatar;
        item.char = want;
        item.loading = null;
        item.lastQ = -1;
      })
      .catch((err) => {
        if (item.loading === want) item.loading = null;
        console.warn('[lobby] 다른 플레이어 캐릭터를 불러오지 못함', err);
      });
  }

  /** 머리 위 이름표 (화면 좌표, 카메라 뒤·멀면 숨김) */
  private placeTag(item: Item, a: PlayerAvatar, cam: THREE.PerspectiveCamera, w: number, h: number, dist: number): void {
    _v.copy(a.headCenter);
    _v.y += a.headRadius + 0.32;
    _v.project(cam);
    const show = dist < TAG_DIST && _v.z < 1 && Math.abs(_v.x) < 1.1 && Math.abs(_v.y) < 1.1;
    item.tag.style.display = show ? '' : 'none';
    if (show) item.tag.style.transform = `translate(${((_v.x + 1) / 2) * w}px, ${((1 - _v.y) / 2) * h}px) translate(-50%, -100%)`;
  }
}
