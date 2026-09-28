import { useEffect, useState } from 'react'
import { ChevronDown, Circle, CircleCheck, CircleDashed, CircleMinus } from '@gravity-ui/icons'
import type { InvestigationPlan, InvestigationPlanStepStatus } from './agentInvestigationPlan'

const STATUS_LABELS: Record<InvestigationPlanStepStatus, string> = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
  skipped: '已跳过',
}

const STATUS_ICONS = {
  pending: Circle,
  in_progress: CircleDashed,
  completed: CircleCheck,
  skipped: CircleMinus,
} satisfies Record<InvestigationPlanStepStatus, typeof Circle>

const EXIT_DURATION_MS = 220

export function InvestigationPlanPanel({
  plan,
  visible = true,
}: {
  plan: InvestigationPlan
  visible?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(visible)
  const completed = plan.steps.filter((step) => step.status === 'completed').length
  const skipped = plan.steps.filter((step) => step.status === 'skipped').length
  const total = plan.steps.length
  const finished = completed + skipped
  const activeStep = plan.steps.find((step) => step.status === 'in_progress')
    || plan.steps.find((step) => step.status === 'pending')
  const done = total > 0 && finished === total
  const SummaryIcon = done ? CircleCheck : CircleDashed

  useEffect(() => {
    if (visible) {
      setMounted(true)
      return
    }
    const timer = window.setTimeout(() => setMounted(false), EXIT_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [visible])

  if (!mounted) return null

  return (
    <section
      aria-label={plan.title}
      aria-live="polite"
      className={`agent-investigation-plan ${visible ? 'is-visible' : 'is-leaving'}`}
    >
      <button
        aria-controls="agent-current-investigation-plan"
        aria-expanded={open}
        className="agent-investigation-plan__trigger"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <SummaryIcon
          aria-hidden="true"
          className={`agent-investigation-plan__summary-icon ${done ? 'is-done' : 'is-active'}`}
        />
        <span className="agent-investigation-plan__title">
          <strong>{plan.title}</strong>
          <small>{activeStep?.title || (done ? '正在整理回答' : '准备任务')}</small>
        </span>
        <span aria-label={`${finished} / ${total} 个步骤已处理`} className="agent-investigation-plan__progress">
          {finished}<span aria-hidden="true">/</span>{total}
        </span>
        <ChevronDown aria-hidden="true" className={`agent-investigation-plan__chevron ${open ? 'is-open' : ''}`} />
      </button>
      <div
        aria-hidden={!open}
        className={`agent-investigation-plan__body ${open ? 'is-open' : ''}`}
        id="agent-current-investigation-plan"
      >
        <div className="agent-investigation-plan__body-inner">
          {total > 0 && (
            <ol className="agent-investigation-plan__steps">
              {plan.steps.map((step) => {
                const Icon = STATUS_ICONS[step.status]
                return (
                  <li
                    aria-label={`${step.title}，${STATUS_LABELS[step.status]}`}
                    className="agent-investigation-plan__step"
                    data-status={step.status}
                    key={step.id}
                  >
                    <Icon aria-hidden="true" className="agent-investigation-plan__icon" />
                    <strong>{step.title}</strong>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      </div>
    </section>
  )
}
