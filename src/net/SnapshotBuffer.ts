// 원격 플레이어 상태 보간 (순수 계산, three.js 없음).
// 보낸 쪽 시각(t)을 로컬 시각으로 옮겨(가장 빨리 도착한 패킷 기준 오프셋) 도착 간격 흔들림(jitter)을 없애고,
// 화면은 "지금 - 보간 지연" 시점을 두 스냅샷 사이로 보간한다. 최신보다 앞서면 속도로 짧게 외삽 후 멈춤.
import type { NetStatePacket } from './shared/protocol';

export interface Snapshot {
  /** 로컬 시각으로 옮긴 보낸 시각 (ms) */
  time: number;
  pkt: NetStatePacket;
}

export interface Sampled {
  p: [number, number, number];
  v: [number, number, number];
  yaw: number;
  aim: [number, number, number];
  pitch: number;
  /** 가까운 쪽 스냅샷 (불연속 값: 모드·무기·플래그) */
  near: NetStatePacket;
  /** 외삽 중 (최신 스냅샷보다 앞선 시점) */
  extrapolating: boolean;
  /** 순간이동(리스폰 등)으로 보간하지 않음 */
  snapped: boolean;
}

/** 도착 간격 통계에 쓰는 최근 패킷 수 (전송 20Hz 기준 약 2초) */
const GAP_WINDOW = 40;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * t;
}

export class SnapshotBuffer {
  private readonly snaps: Snapshot[] = [];
  private offset: number | null = null;
  private lastSeq = -1;
  private lastRelax = 0;
  /** 외삽 최대 시간 (ms) */
  maxExtrapolateMs = 100;
  /** 이 거리보다 크게 움직이면 보간하지 않고 바로 이동 (m) */
  teleportDistance = 4;
  /** 디버그: 순번 역전·중복으로 버린 수, 도착 간격 */
  dropped = 0;
  lastArrivalGap = 0;
  /** 디버그: 최근 도착 간격 평균·최대 (ms, 최근 GAP_WINDOW개) */
  gapAvg = 0;
  gapMax = 0;
  private readonly gaps: number[] = [];
  private lastArrival = 0;

  get size(): number {
    return this.snaps.length;
  }

  /** 버퍼 길이 (ms, 가장 오래된 → 최신) */
  get spanMs(): number {
    return this.snaps.length > 1 ? this.snaps[this.snaps.length - 1]!.time - this.snaps[0]!.time : 0;
  }

  get latest(): NetStatePacket | null {
    return this.snaps.length ? this.snaps[this.snaps.length - 1]!.pkt : null;
  }

  push(pkt: NetStatePacket, now: number): void {
    if (pkt.q <= this.lastSeq) {
      this.dropped++;
      return;
    }
    // 보낸 쪽이 새로고침 등으로 순번을 처음부터 시작하면 버퍼 초기화
    if (this.lastSeq >= 0 && pkt.q < this.lastSeq - 1000) this.clear();
    this.lastSeq = pkt.q;
    if (this.lastArrival) {
      this.lastArrivalGap = now - this.lastArrival;
      this.gaps.push(this.lastArrivalGap);
      if (this.gaps.length > GAP_WINDOW) this.gaps.shift();
      let sum = 0;
      let max = 0;
      for (const g of this.gaps) {
        sum += g;
        if (g > max) max = g;
      }
      this.gapAvg = sum / this.gaps.length;
      this.gapMax = max;
    }
    this.lastArrival = now;
    const off = now - pkt.t;
    // 오프셋 = 관측된 최소 지연. 시계 드리프트·경로 변화에 따라가게 1초마다 0.5ms씩 늦춤
    if (this.offset === null || off < this.offset) this.offset = off;
    else if (now - this.lastRelax > 1000) {
      this.offset += 0.5;
      this.lastRelax = now;
    }
    this.snaps.push({ time: pkt.t + this.offset, pkt });
    while (this.snaps.length > 2 && this.snaps[0]!.time < now - 1500) this.snaps.shift();
  }

  /** 디버그: 최신 스냅샷이 화면 시점보다 앞선 양 (ms). 음수 = 최신보다 앞서 외삽 중 */
  leadMs(renderTime: number): number {
    return this.snaps.length ? this.snaps[this.snaps.length - 1]!.time - renderTime : 0;
  }

  clear(): void {
    this.snaps.length = 0;
    this.gaps.length = 0;
    this.offset = null;
    this.lastSeq = -1;
  }

  /** renderTime(로컬 ms) 시점의 상태 */
  sample(renderTime: number): Sampled | null {
    const s = this.snaps;
    if (s.length === 0) return null;
    const last = s[s.length - 1]!;
    if (renderTime >= last.time) {
      const dt = Math.min(renderTime - last.time, this.maxExtrapolateMs) / 1000;
      const p = last.pkt;
      return {
        p: [p.p[0] + p.v[0] * dt, p.p[1] + p.v[1] * dt, p.p[2] + p.v[2] * dt],
        v: p.v,
        yaw: p.y,
        aim: p.a,
        pitch: p.pi,
        near: p,
        extrapolating: renderTime > last.time + 1,
        snapped: false,
      };
    }
    if (s.length === 1) return this.fromPacket(last.pkt, false);
    let i = s.length - 2;
    while (i > 0 && s[i]!.time > renderTime) i--;
    const a = s[i]!;
    const b = s[i + 1]!;
    if (renderTime <= a.time) return this.fromPacket(a.pkt, false);
    const t = (renderTime - a.time) / Math.max(1, b.time - a.time);
    const pa = a.pkt;
    const pb = b.pkt;
    const jump = Math.hypot(pb.p[0] - pa.p[0], pb.p[1] - pa.p[1], pb.p[2] - pa.p[2]) > this.teleportDistance;
    if (jump) return this.fromPacket(t < 0.5 ? pa : pb, true);
    const ax = lerp(pa.a[0], pb.a[0], t);
    const ay = lerp(pa.a[1], pb.a[1], t);
    const az = lerp(pa.a[2], pb.a[2], t);
    const al = Math.hypot(ax, ay, az) || 1;
    return {
      p: [lerp(pa.p[0], pb.p[0], t), lerp(pa.p[1], pb.p[1], t), lerp(pa.p[2], pb.p[2], t)],
      v: [lerp(pa.v[0], pb.v[0], t), lerp(pa.v[1], pb.v[1], t), lerp(pa.v[2], pb.v[2], t)],
      yaw: lerpAngle(pa.y, pb.y, t),
      aim: [ax / al, ay / al, az / al],
      pitch: lerp(pa.pi, pb.pi, t),
      near: t < 0.5 ? pa : pb,
      extrapolating: false,
      snapped: false,
    };
  }

  private fromPacket(p: NetStatePacket, snapped: boolean): Sampled {
    return { p: [...p.p], v: [...p.v], yaw: p.y, aim: [...p.a], pitch: p.pi, near: p, extrapolating: false, snapped };
  }
}
