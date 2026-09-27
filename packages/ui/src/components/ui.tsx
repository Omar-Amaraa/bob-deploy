import type { JobQuestion, JobStepView } from '@bob-deploy/contracts';
import { CircleAlert, CircleCheck, CircleDashed, Eye, EyeOff, LoaderCircle, X } from 'lucide-react';
import {
  forwardRef,
  useId,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentPropsWithoutRef,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';

export function Button({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`button ${className}`} {...props} />;
}

export function Card({ children, className = '', ...props }: ComponentPropsWithoutRef<'section'>) {
  return (
    <section className={`card ${className}`} {...props}>
      {children}
    </section>
  );
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  help?: string;
  error?: string;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, help, error, id: providedId, ...props },
  ref,
) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        ref={ref}
        id={id}
        aria-invalid={Boolean(error)}
        aria-describedby={[helpId, errorId].filter(Boolean).join(' ') || undefined}
        {...props}
      />
      {help ? (
        <span id={helpId} className="field-help">
          {help}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className="field-error" aria-live="polite">
          {error}
        </span>
      ) : null}
    </div>
  );
});

export const PasswordField = forwardRef<HTMLInputElement, FieldProps>(function PasswordField(props, ref) {
  const [visible, setVisible] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  return (
    <div className="password-field">
      <Field
        {...props}
        ref={ref}
        type={visible ? 'text' : 'password'}
        onKeyDown={(event) => {
          setCapsLock(event.getModifierState('CapsLock'));
          props.onKeyDown?.(event);
        }}
      />
      <button
        type="button"
        className="icon-button password-toggle"
        aria-label={visible ? 'Hide password' : 'Show password'}
        onClick={() => setVisible((value) => !value)}
      >
        {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      </button>
      {capsLock ? (
        <p className="field-help" role="status">
          Caps Lock is on.
        </p>
      ) : null}
    </div>
  );
});

export function Pill({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'good' | 'warning' | 'bad';
}) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <Card className="state">
      <CircleDashed aria-hidden="true" />
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </Card>
  );
}

export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <Card className="state error-state" role="alert">
      <CircleAlert aria-hidden="true" />
      <h2>We could not load this</h2>
      <p>{message}</p>
      {retry ? <Button onClick={retry}>Try again</Button> : null}
    </Card>
  );
}

export function Skeleton({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      <span />
      <span />
      <span />
    </div>
  );
}

export function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusable = () => [
      ...(dialog?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]',
      ) ?? []),
    ];
    const preferredFocus = dialog?.querySelector<HTMLElement>('[data-dialog-autofocus]');
    (preferredFocus ?? focusable()[0])?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <button className="icon-button dialog-close" aria-label="Close" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
        <h2 id="dialog-title">{title}</h2>
        {children}
      </section>
    </div>
  );
}

export function Toast({ children }: { children: ReactNode }) {
  return (
    <div className="toast" role="status" aria-live="polite">
      {children}
    </div>
  );
}

export function StepList({ steps }: { steps: JobStepView[] }) {
  return (
    <ol className="step-list">
      {steps.map((step) => (
        <li key={step.id}>
          {step.status === 'succeeded' ? (
            <CircleCheck aria-hidden="true" />
          ) : step.status === 'running' ? (
            <LoaderCircle aria-hidden="true" />
          ) : (
            <CircleDashed aria-hidden="true" />
          )}
          <span>{step.name}</span>
        </li>
      ))}
    </ol>
  );
}

export function QuestionCard({
  question,
  onAnswer,
}: {
  question: JobQuestion;
  onAnswer: (value: string | boolean) => void;
}) {
  const [value, setValue] = useState('');
  const answerRef = useRef<HTMLInputElement>(null);
  const [hasAnswer, setHasAnswer] = useState(false);
  useEffect(() => {
    setValue('');
    setHasAnswer(false);
  }, [question.questionId]);
  return (
    <Card>
      <h3>{question.title}</h3>
      <p>{question.body}</p>
      {question.kind === 'confirm' ? (
        <div className="button-row">
          <Button onClick={() => onAnswer(true)}>{question.confirmLabel ?? 'Continue'}</Button>
          <Button className="button-secondary" onClick={() => onAnswer(false)}>
            {question.cancelLabel ?? 'Cancel'}
          </Button>
        </div>
      ) : question.kind === 'choice' ? (
        <div>
          {question.options?.map((option) => (
            <label key={option.id} className="choice">
              <input
                type="radio"
                name={question.questionId}
                value={option.id}
                onChange={() => setValue(option.id)}
              />
              {option.label}
            </label>
          ))}
          <Button disabled={!value} onClick={() => onAnswer(value)}>
            Continue
          </Button>
        </div>
      ) : (
        <div>
          <Field
            key={question.questionId}
            ref={answerRef}
            label={question.title}
            type={question.kind === 'secret' ? 'password' : 'text'}
            autoComplete="off"
            defaultValue=""
            onInput={(event) => setHasAnswer(event.currentTarget.value.length > 0)}
          />
          <Button
            disabled={!hasAnswer}
            onClick={() => {
              const answer = answerRef.current?.value ?? '';
              if (!answer) return;
              onAnswer(answer);
              if (answerRef.current) answerRef.current.value = '';
              setHasAnswer(false);
            }}
          >
            Continue
          </Button>
        </div>
      )}
    </Card>
  );
}

export function ChartPlaceholder({ label, values }: { label: string; values: number[] }) {
  const maximum = Math.max(...values, 1);
  return (
    <div className="chart" role="img" aria-label={label}>
      {values.slice(-24).map((value, index) => (
        <span key={index} style={{ height: `${Math.max(8, (value / maximum) * 100)}%` }} />
      ))}
    </div>
  );
}
