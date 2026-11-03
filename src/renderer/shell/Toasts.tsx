import { useUi } from '../state/ui'
import { Icon } from '../components/Icon'
import { Button } from '../components/ui'

export function Toasts() {
  const toasts = useUi((s) => s.toasts)
  const dismiss = useUi((s) => s.dismiss)
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast glass glass-strong ${t.kind}`}>
          <Icon name={t.kind === 'error' ? 'warning' : t.kind === 'ok' ? 'check' : 'info'} size={15} />
          <span>{t.text}</span>
          {t.action && (
            <Button
              small
              kind="ghost"
              onClick={() => {
                t.action!.run()
                dismiss(t.id)
              }}
            >
              {t.action.label}
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}
