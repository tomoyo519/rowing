import type { Session } from '../game/state'
import type { Course } from '../game/courses'
import type { GameModeId } from '../game/modes'
import { RhythmCombo, type ComboEvent } from '../game/combo'
import { createPowerZones, PowerZoneTracker, type ZoneEvent } from '../game/powerZones'
import { createCheckpoints, CheckpointTracker, type CheckpointPass } from '../game/checkpoints'
import { SwanCrossing, type SwanEvent } from '../game/wildlife'
import { WeatherBonusTracker } from '../game/weatherBonus'
import { profileSections, meanIntensityBetween } from '../game/profile'
import { splitToSpeed } from '../game/physics'
import { Cox, type CoxEvent } from '../game/cox'
import { HrZoneGauge, loadMaxHr, targetZoneForTier, type HrEvent } from '../game/hrZone'
import { addCoins, CoinLedger, COIN_RULES, loadWallet, saveWallet, touchDay, type LedgerEntry } from '../game/wallet'
import { kstDateKey, type DailyChallenge } from '../game/daily'
import type { RaceHud } from './raceHud'
import { ArcadeHud } from './arcadeHud'
import type { CoxVoice } from '../audio/coxVoice'
import type { AmbientSoundscape } from '../audio/ambience'

/**
 * 재미 요소 컨트롤러 — 세션 위에 얹히는 게임 층을 한 곳에서 돌린다.
 *
 * main.ts는 네 군데서만 부른다: start(레이스 시작), frame(매 프레임), finish(요약 직전), stop(화면 정리).
 * 세션·3D·HUD 본체는 건드리지 않고 Session의 지표만 읽는다. 순수 로직(combo·powerZones·checkpoints·wildlife·
 * weatherBonus·cox·hrZone·wallet)은 각자 테스트되고, 여기서는 그걸 소리(CoxVoice)·DOM(ArcadeHud)·미니맵 표식(RaceHud)으로 바꾼다.
 */
export interface ArcadeStart {
  session: Session
  course: Course
  /** 예상 완주 거리 (m) — 랜드마크 위치의 기준 */
  total: number
  tierId: string
  mode: GameModeId
  /** 오늘의 도전으로 시작했으면 그 도전 */
  daily: DailyChallenge | null
  /** 친구 고스트 이름. 없으면 null */
  friendGhostName: string | null
  /** 심박 센서가 붙어 있거나 기기가 심박을 보내는지 */
  hasHr: boolean
}

export interface ArcadeSummary {
  entries: LedgerEntry[]
  coinsTotal: number
  /** 적립 뒤 지갑 잔액 */
  walletCoins: number
  streak: number
  comboBest: number
  goodStrokes: number
  strokes: number
  zones: { attempted: number; successes: number }
  checkpoints: CheckpointPass[]
  swans: { attempts: number; successes: number }
  hrBoosts: number
  daily: DailyChallenge | null
  friendGhostName: string | null
}

/** 5분 피드백 주기 — main.ts와 같은 규칙(`?checkpoint=초`) */
function feedbackPeriod(): number {
  const q = Number(new URLSearchParams(location.search).get('checkpoint'))
  return q > 0 ? q : 5 * 60
}

export class Arcade {
  private readonly hud = new ArcadeHud()
  private session: Session | null = null
  private opts: ArcadeStart | null = null
  private combo = new RhythmCombo()
  private zones = new PowerZoneTracker([])
  private checkpoints = new CheckpointTracker([])
  private swans: SwanCrossing | null = null
  private weather: WeatherBonusTracker | null = null
  private cox = new Cox()
  private hr = new HrZoneGauge()
  private ledger = new CoinLedger()
  private mult = 1
  private multLabel: string | null = null
  private lastPhase = 0
  private stoppedFor = 0
  private lastStepLabel: string | null = null
  private lastFeedbackDue = 0
  private readonly feedbackPeriod = feedbackPeriod()

  constructor(
    private readonly raceHud: RaceHud,
    private readonly voice: CoxVoice,
    private readonly ambience: AmbientSoundscape,
  ) {}

  /** 지금 콤보 단계 (0~5) — 물보라 세기에 쓴다 */
  get comboLevel() { return this.session ? this.combo.level : 0 }

  start(o: ArcadeStart) {
    this.session = o.session
    this.opts = o
    const seed = o.session.weatherSeed
    const D = o.course.durationSec
    this.combo = new RhythmCombo()
    this.zones = new PowerZoneTracker(createPowerZones(seed, o.course.profile, D))
    this.checkpoints = new CheckpointTracker(createCheckpoints(o.course.venue.landmarks, o.total))
    this.swans = new SwanCrossing(seed, D)
    this.weather = new WeatherBonusTracker(seed, D, profileSections(o.course.profile, D))
    this.cox = new Cox(seed)
    this.hr = new HrZoneGauge(loadMaxHr(), targetZoneForTier(o.tierId))
    this.ledger = new CoinLedger()
    this.mult = 1
    this.multLabel = null
    this.lastPhase = 0
    this.stoppedFor = 0
    this.lastStepLabel = null
    this.lastFeedbackDue = 0
    this.hud.start({ hasHr: o.hasHr, targetZone: this.hr.targetZone })
    this.raceHud.setStripMarkers(this.zones.zones)
    if (o.friendGhostName) this.raceHud.setGhostLabel(`친구 ${o.friendGhostName}`)
  }

  /** 매 프레임. main의 updateHud 뒤에 부른다 */
  frame(session: Session, dt: number) {
    if (!this.session || session !== this.session || !this.opts || !this.swans || !this.weather) return
    const m = session.metrics()
    const running = session.phase === 'running' && !m.stalled
    const elapsed = m.elapsed

    // ── 날씨 보너스 ──
    const wb = this.weather.update(elapsed)
    this.mult = wb.mult
    if (wb.changed && running && wb.label !== this.multLabel) {
      this.onEvent({ kind: 'weather', label: wb.label, mult: wb.mult }, elapsed)
    }
    this.multLabel = wb.label
    if (running) this.ledger.addDistance(m.distance, wb.mult)
    else this.ledger.mark(m.distance)

    // ── 다른 음성과 겹치지 않게 ──
    if (this.lastStepLabel !== null && m.step.label !== this.lastStepLabel) this.cox.hush(elapsed + 4)
    this.lastStepLabel = m.step.label
    const due = this.lastFeedbackDue + this.feedbackPeriod
    if (running && elapsed >= due) {
      this.lastFeedbackDue = due
      if (m.remaining >= 45) this.cox.hush(elapsed + 7)
    }

    // ── 스트로크 완료 → 콤보 ──
    const phase = session.stroke.phase
    if (running && phase < this.lastPhase - 0.5) this.onStroke(m.split - m.targetSplit)
    this.lastPhase = phase
    if (running && m.spm < 8) {
      this.stoppedFor += dt
      if (this.stoppedFor > 3 && this.combo.count > 0) {
        const e = this.combo.onStop()
        this.hud.setCombo(0, 0, false)
        if (e) this.onEvent(e, elapsed)
      }
    } else {
      this.stoppedFor = 0
    }

    // ── 파워 구간 ──
    if (running) for (const e of this.zones.update(elapsed, m.distance, m.targetSplit)) this.onEvent(e, elapsed)
    const zv = this.zones.view(elapsed, m.distance, m.targetSplit)
    this.hud.setZone(zv)

    // ── 백조 떼 (파워 구간과 겹치지 않게) ──
    const nextZoneIn = this.zones.nextStartsIn(elapsed)
    const blocked = zv !== null || (nextZoneIn !== null && nextZoneIn < 25)
    if (running) for (const e of this.swans.update(elapsed, m.distance, m.speed, blocked)) this.onEvent(e, elapsed)
    const sv = this.swans.view(elapsed, m.distance)
    this.hud.setSwans(sv)

    // ── 랜드마크 체크포인트 ──
    if (running) {
      for (const p of this.checkpoints.update(m.distance, elapsed, m.gap, m.ghostGap)) this.onEvent({ kind: 'checkpoint', pass: p }, elapsed)
    }

    // ── 심박 존 ──
    for (const e of this.hr.update(dt, running ? m.heartRate : undefined)) this.onEvent(e, elapsed)
    this.hud.setHr(m.heartRate !== undefined && m.heartRate > 0
      ? { fill: this.hr.fill, zone: this.hr.zone, target: this.hr.targetZone, boosting: this.hr.boosting }
      : null)

    // ── 코인 표시 ──
    this.hud.setCoins(this.ledger.total, this.mult, this.multLabel)

    // ── 미니맵 표식: 파워 구간의 선은 페이스 보트가 그 시각에 있을 자리 ──
    let zoneAlong: number | null = null
    if (zv) {
      const at = zv.state === 'soon' ? zv.zone.start : zv.zone.end
      const paceDistance = m.distance - m.gap
      const left = Math.max(0, at - elapsed)
      const mean = meanIntensityBetween(session.course.profile, elapsed, at)
      zoneAlong = paceDistance + splitToSpeed(session.baseSplit) * mean * left - m.distance
    }
    this.raceHud.setMarkers({ zoneAlong, zoneActive: zv?.state === 'active', swanAlong: sv ? sv.along : null })

    // ── 콕스 ──
    const line = this.cox.tick({
      elapsed, remaining: m.remaining, delta: m.split - m.targetSplit, spm: m.spm, running,
      nextStepIn: m.nextStep?.startsIn ?? null, nextLabel: m.nextStep?.label ?? null,
      nextHarder: m.nextStep ? m.nextStep.intensity > m.intensity + 0.02 : false,
    })
    if (line) this.voice.call(line)
  }

  private onStroke(delta: number) {
    const before = this.combo.count
    const e = this.combo.onStroke(delta)
    const good = this.combo.count > before
    this.hud.setCombo(this.combo.count, this.combo.level, good)
    this.hud.setComboBest(this.combo.best)
    if (e) this.onEvent(e, this.session?.elapsed ?? 0)
  }

  private coins(label: string, coins: number) {
    this.ledger.add(label, coins)
    this.hud.coinPop()
  }

  private onEvent(e: CoxEvent | ComboEvent | ZoneEvent | SwanEvent | HrEvent, elapsed: number) {
    const friend = this.opts?.friendGhostName
    switch (e.kind) {
      case 'combo-milestone': {
        const c = COIN_RULES.combo[e.count] ?? 0
        if (c) this.coins(`${e.count} 콤보`, c)
        this.voice.combo(e.level)
        this.hud.toast(`${e.count} 콤보!`, c ? `+${c} 코인 · 리듬 그대로` : '리듬 그대로', 'win')
        break
      }
      case 'combo-break':
        this.voice.comboBreak()
        this.hud.toast('콤보 끊김', `${e.count}에서 멈췄어요 · 다시 쌓아요`, 'warn')
        break
      case 'zone-soon':
        this.hud.toast('10초 뒤 파워 구간', '30초 동안 목표보다 3초 빠르게', 'warn')
        break
      case 'zone-start':
        this.voice.zoneStart()
        this.hud.toast('파워 구간!', '30초 전력', 'danger')
        break
      case 'zone-end':
        this.voice.zoneResult(e.success)
        if (e.success) {
          this.coins('파워 구간', COIN_RULES.zoneSuccess)
          this.ambience.cue('cheer')
          this.hud.toast('파워 구간 성공!', `목표보다 ${Math.abs(e.deltaSec).toFixed(1)}초 빠름 · +${COIN_RULES.zoneSuccess} 코인`, 'win')
        } else {
          this.hud.toast('파워 구간 아쉬움', isFinite(e.deltaSec) ? `목표보다 ${e.deltaSec >= 0 ? '+' : '−'}${Math.abs(e.deltaSec).toFixed(1)}초 · 다음에 다시` : '다음 구간에서 다시', 'warn')
        }
        break
      case 'swans-appear':
        this.hud.toast('백조 떼!', '10초 안에 통과하세요', 'warn')
        break
      case 'swans-result':
        if (e.success) {
          this.coins('백조 통과', COIN_RULES.swans)
          this.voice.coin()
          this.ambience.cue('duck')
          this.hud.toast('백조 통과!', `${Math.max(0, e.margin).toFixed(1)}초 남기고 · +${COIN_RULES.swans} 코인`, 'win')
        } else {
          this.hud.toast('백조가 먼저 갔어요', '다음엔 조금만 더', 'info')
        }
        break
      case 'checkpoint': {
        const p = e.pass
        const lead = p.gap >= 0
        this.voice.checkpoint(lead)
        if (lead) this.coins('체크포인트 리드', COIN_RULES.checkpointLead)
        const g = Math.round(p.gap)
        let sub = `페이스 보트보다 ${Math.abs(g)}m ${lead ? '앞' : '뒤'}`
        if (p.ghostGap !== null) {
          const gg = Math.round(p.ghostGap)
          sub += ` · ${friend ? `친구 ${friend}` : '내 최고'}보다 ${Math.abs(gg)}m ${gg >= 0 ? '앞' : '뒤'}`
        }
        this.hud.toast(p.name, sub, lead ? 'win' : 'info')
        break
      }
      case 'hr-boost':
        this.voice.boost()
        this.coins('심박 부스트', COIN_RULES.hrBoost)
        this.hud.toast('심박 존 완성!', `10초 부스트 · +${COIN_RULES.hrBoost} 코인`, 'win')
        break
      case 'hr-high':
        this.hud.toast('심박이 높아요', '길게 내쉬며 레이트를 조금 내려요', 'warn')
        break
      case 'weather':
        if (e.label) this.hud.toast(`${e.label} 보너스`, `코인 ×${Number.isInteger(e.mult) ? e.mult : e.mult.toFixed(1)}`, 'win')
        break
      case 'launch':
        break
    }
    const line = this.cox.event(e, elapsed)
    if (line) this.voice.call(line, e.kind === 'zone-start' || e.kind === 'swans-appear')
  }

  /**
   * 레이스가 끝났다. 코인을 지갑에 넣고 요약 재료를 돌려준다.
   * 1분 미만·50m 미만(기록으로도 안 남는 세션)은 코인도 없다.
   */
  finish(session: Session, completed: boolean): ArcadeSummary {
    const o = this.opts
    const m = session.metrics()
    let wallet = loadWallet()
    let streak = wallet.streak
    const countable = m.elapsed >= 60 && m.distance > 50
    if (completed && countable) {
      this.ledger.add('완주', COIN_RULES.completion)
      const t = touchDay(wallet, kstDateKey())
      wallet = t.wallet
      streak = t.streak
      if (t.newDay && t.bonus > 0) this.ledger.add(`연속 ${t.streak}일째`, t.bonus)
      if (o?.daily) this.ledger.add('오늘의 도전 ×1.5', Math.round(this.ledger.total * (COIN_RULES.dailyMult - 1)))
    }
    const total = countable ? this.ledger.total : 0
    if (countable) {
      wallet = addCoins(wallet, total)
      saveWallet(wallet)
    }
    return {
      entries: countable ? this.ledger.entries() : [],
      coinsTotal: total,
      walletCoins: wallet.coins,
      streak,
      comboBest: this.combo.best,
      goodStrokes: this.combo.goodStrokes,
      strokes: this.combo.strokes,
      zones: { attempted: this.zones.attempted, successes: this.zones.successes },
      checkpoints: [...this.checkpoints.passes],
      swans: { attempts: this.swans?.attempts ?? 0, successes: this.swans?.successes ?? 0 },
      hrBoosts: this.hr.boosts,
      daily: o?.daily ?? null,
      friendGhostName: o?.friendGhostName ?? null,
    }
  }

  /** 레이스 화면을 떠난다 — HUD를 치운다 */
  stop() {
    this.session = null
    this.opts = null
    this.hud.stop()
    this.raceHud.setMarkers({ zoneAlong: null, zoneActive: false, swanAlong: null })
  }
}
