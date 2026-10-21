/** 체력 + 리스폰 보호(무적). 렌더링과 무관한 순수 로직 (플레이어·봇 공용) */
export class Health {
  hp: number;
  /** 남은 무적 시간 */
  protection = 0;

  constructor(private max: number) {
    this.hp = max;
  }

  /** 최대 체력 (캐릭터 능력치). 리스폰하면 이 값으로 회복 */
  get maxHp(): number {
    return this.max;
  }

  /** 캐릭터 교체: 최대 체력 변경 + 가득 채움 */
  setMaxHp(maxHp: number): void {
    this.max = maxHp;
    this.hp = maxHp;
  }

  get alive(): boolean {
    return this.hp > 0;
  }

  get protected(): boolean {
    return this.protection > 0;
  }

  /** @returns 실제로 깎인 양 */
  applyDamage(amount: number): number {
    if (!this.alive || this.protected || amount <= 0) return 0;
    const before = this.hp;
    this.hp = Math.max(0, this.hp - amount);
    return before - this.hp;
  }

  kill(): void {
    this.hp = 0;
    this.protection = 0;
  }

  /** 리스폰: 체력 회복 + 보호 시작 */
  reset(protection: number): void {
    this.hp = this.max;
    this.protection = protection;
  }

  /** 공격하면 보호 해제 */
  breakProtection(): void {
    this.protection = 0;
  }

  update(dt: number): void {
    this.protection = Math.max(0, this.protection - dt);
  }
}
