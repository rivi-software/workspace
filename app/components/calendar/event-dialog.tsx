import { MapPin, Repeat, Trash2, Users } from "lucide-react";
import { useId, useState } from "react";
import type { FormEvent } from "react";

import {
  ATTENDEE_STATUS_LABEL,
  MAX_EVENT_TEXT,
  MAX_EVENT_TITLE,
  REPEATS,
  REPEAT_LABEL,
  addDays,
  allDayRange,
  fromInputs,
  isRepeat,
  localDay,
  readerZone,
  timeRange,
  toDateInput,
  toTimeInput,
  utcDay,
} from "~/lib/calendar/calendar";
import type {
  AttendeeStatus,
  Repeat as RepeatKind,
} from "~/lib/calendar/calendar";
import type { EventView } from "~/lib/calendar/calendar.server";
import { withCleanup } from "~/lib/cleanup";

import {
  Avatar,
  Button,
  Checkbox,
  Dialog,
  Field,
  Notice,
  Pill,
  cx,
  inputClass,
  selectClass,
  textareaClass,
} from "../ui";
import { useCalendarAction } from "./use-calendar-action";

export interface Colleague {
  id: string;
  name: string;
  email: string;
}

/** Where a new event starts from: the slot that was pressed, or now rounded up to the half hour. */
export interface EventDraft {
  start: Date;
  end: Date;
  allDay: boolean;
}

export const draftAt = (start: Date, allDay = false): EventDraft => {
  const s = new Date(start);

  if (allDay) {
    s.setHours(0, 0, 0, 0);

    return { start: s, end: new Date(s.getTime() + 86_400_000), allDay };
  }

  s.setSeconds(0, 0);
  s.setMinutes(Math.ceil(s.getMinutes() / 30) * 30);

  return { start: s, end: new Date(s.getTime() + 60 * 60_000), allDay };
};

interface Form {
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  repeat: RepeatKind;
  repeatUntil: string;
  location: string;
  description: string;
  attendees: string[];
}

const formOf = (event: EventView | null, draft: EventDraft | null): Form => {
  if (event) {
    const start = new Date(event.startsAt);
    const end = new Date(event.endsAt);

    return {
      title: event.title,
      allDay: event.allDay,
      startDate: event.allDay ? utcDay(event.startsAt) : toDateInput(start),
      startTime: event.allDay ? "09:00" : toTimeInput(start),
      endDate: event.allDay
        ? addDays(utcDay(event.endsAt), -1)
        : toDateInput(end),
      endTime: event.allDay ? "10:00" : toTimeInput(end),
      repeat: event.repeat,
      repeatUntil: event.repeatUntil ?? "",
      location: event.location,
      description: event.description,
      attendees: event.attendees.map((a) => a.id),
    };
  }

  const d = draft ?? draftAt(new Date());

  return {
    title: "",
    allDay: d.allDay,
    startDate: toDateInput(d.start),
    startTime: d.allDay ? "09:00" : toTimeInput(d.start),
    endDate: d.allDay
      ? toDateInput(new Date(d.end.getTime() - 1))
      : toDateInput(d.end),
    endTime: d.allDay ? "10:00" : toTimeInput(d.end),
    repeat: "none",
    repeatUntil: "",
    location: "",
    description: "",
    attendees: [],
  };
};

/** The moments a form names, or what is wrong with them. */
const momentsOf = (
  f: Form
): { startsAt: string; endsAt: string } | { error: string } => {
  if (f.allDay) {
    if (!f.startDate || !f.endDate) {
      return { error: "Choose the days." };
    }

    return allDayRange(f.startDate, f.endDate);
  }

  const start = fromInputs(f.startDate, f.startTime);
  const end = fromInputs(f.endDate, f.endTime);

  if (!start || !end) {
    return { error: "Choose when it starts and ends." };
  }

  if (end.getTime() <= start.getTime()) {
    return { error: "An event ends after it starts." };
  }

  return { startsAt: start.toISOString(), endsAt: end.toISOString() };
};

const STATUS_TONE: Record<AttendeeStatus, "neutral" | "accent" | "red"> = {
  "needs-action": "neutral",
  accepted: "accent",
  declined: "red",
};

/** "Tue 3 Nov" for a UTC calendar day: the days of an all-day event are dates, never moments in the reader's zone. */
const utcDayLabel = (key: string): string =>
  new Date(`${key}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

/** "Tue 3 Nov, 10:00 – 11:00", or the days of an all-day event, in the reader's zone. */
export const whenLabel = (
  event: Pick<EventView, "startsAt" | "endsAt" | "allDay">
): string => {
  if (event.allDay) {
    const first = utcDay(event.startsAt);
    const last = addDays(utcDay(event.endsAt), -1);

    return first === last
      ? `${utcDayLabel(first)}, all day`
      : `${utcDayLabel(first)} – ${utcDayLabel(last)}`;
  }

  const start = new Date(event.startsAt);

  const sameDay =
    localDay(event.startsAt) ===
    localDay(new Date(Date.parse(event.endsAt) - 1));

  const date = start.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

  if (sameDay) {
    return `${date}, ${timeRange(event.startsAt, event.endsAt)}`;
  }

  return `${date} ${toTimeInput(start)} – ${new Date(event.endsAt).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} ${toTimeInput(new Date(event.endsAt))}`;
};

/** An event a colleague invited the reader to: what it is, who comes, and the reader's answer. */
const EventDetails = ({
  open,
  event,
  onClose,
  onRespond,
  busy,
}: {
  open: boolean;
  event: EventView;
  onClose: () => void;
  onRespond: (status: AttendeeStatus) => void;
  busy: boolean;
}) => (
  <Dialog open={open} onClose={onClose} title={event.title}>
    <div className="space-y-3 text-base">
      <div className="text-muted">{whenLabel(event)}</div>
      {event.repeat !== "none" && (
        <div className="text-muted flex items-center gap-1.5">
          <Repeat className="h-3.5 w-3.5" />
          {REPEAT_LABEL[event.repeat]}
          {event.repeatUntil && ` until ${event.repeatUntil}`}
        </div>
      )}
      {event.location && (
        <div className="flex items-center gap-1.5">
          <MapPin className="text-subtle h-3.5 w-3.5" />
          {event.location}
        </div>
      )}
      {event.description && (
        <p className="whitespace-pre-wrap">{event.description}</p>
      )}
      <div>
        <div className="text-muted mb-1 flex items-center gap-1.5 text-sm font-medium">
          <Users className="h-3.5 w-3.5" />
          Invited by {event.owner.name}
        </div>
        <ul className="space-y-0.5">
          {event.attendees.map((a) => (
            <li key={a.id} className="flex items-center gap-2">
              <Avatar name={a.name} size={16} />
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
              <Pill tone={STATUS_TONE[a.status]}>
                {ATTENDEE_STATUS_LABEL[a.status]}
              </Pill>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex items-center justify-end gap-2">
        {event.myStatus !== "declined" && (
          <Button onClick={() => onRespond("declined")} disabled={busy}>
            Decline
          </Button>
        )}
        {event.myStatus !== "accepted" && (
          <Button
            variant="primary"
            onClick={() => onRespond("accepted")}
            loading={busy}
          >
            Accept
          </Button>
        )}
      </div>
    </div>
  </Dialog>
);

/**
 * An event: a form for a new one or one of the reader's own (title, when, whether it is all day, how it repeats,
 * where, a note, the colleagues invited), or the details of one a colleague invited them to, with Accept and
 * Decline. The moments are read in the reader's zone and sent as instants, with the zone, so a repeat keeps its time.
 */
export const EventDialog = ({
  open,
  event,
  draft,
  colleagues,
  onClose,
}: {
  open: boolean;
  event: EventView | null;
  draft?: EventDraft | null;
  colleagues: Colleague[];
  onClose: () => void;
}) => {
  const run = useCalendarAction();
  const [form, setForm] = useState<Form>(() => formOf(event, draft ?? null));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const allDayId = useId();
  const editable = !event || event.mine;

  // Opening the dialog, or opening it on another event or draft, starts the form over: adjusted while
  // rendering, since an effect would paint the previous one first.
  const [shown, setShown] = useState({ open, event, draft });

  if (shown.open !== open || shown.event !== event || shown.draft !== draft) {
    setShown({ open, event, draft });

    if (open) {
      setForm(formOf(event, draft ?? null));
      setError(null);
    }
  }

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((f) => {
      const next = { ...f, [key]: value };

      // The end follows the start, so an event never ends before it begins while one types.
      if (key === "startDate" && f.endDate < String(value)) {
        next.endDate = String(value);
      }

      return next;
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const moments = momentsOf(form);

    if ("error" in moments) {
      setError(moments.error);

      return;
    }

    if (!form.title.trim()) {
      setError("An event needs a title.");

      return;
    }

    setBusy(true);
    setError(null);

    await withCleanup(
      async () => {
        const r = await run(
          {
            intent: event ? "update" : "create",
            id: event?.id ?? "",
            title: form.title,
            allDay: form.allDay ? "1" : "0",
            startsAt: moments.startsAt,
            endsAt: moments.endsAt,
            timeZone: readerZone(),
            repeat: form.repeat,
            repeatUntil: form.repeat === "none" ? "" : form.repeatUntil,
            location: form.location,
            description: form.description,
            attendees: JSON.stringify(form.attendees),
          },
          { quiet: false }
        );

        if (r?.ok) {
          onClose();
        } else if (r && !r.ok) {
          setError(r.error);
        }
      },
      () => setBusy(false)
    );
  };

  const remove = async () => {
    if (
      !event ||
      // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
      !confirm("Delete this event? Everyone invited loses it too.")
    ) {
      return;
    }

    setBusy(true);

    await withCleanup(
      async () => {
        const r = await run({ intent: "delete", id: event.id });

        if (r?.ok) {
          onClose();
        }
      },
      () => setBusy(false)
    );
  };

  const respond = async (status: AttendeeStatus) => {
    if (!event) {
      return;
    }

    setBusy(true);

    await withCleanup(
      async () => {
        const r = await run({ intent: "respond", id: event.id, status });

        if (r?.ok) {
          onClose();
        }
      },
      () => setBusy(false)
    );
  };

  if (event && !editable) {
    return (
      <EventDetails
        open={open}
        event={event}
        onClose={onClose}
        onRespond={respond}
        busy={busy}
      />
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={event ? "Edit event" : "New event"}
      className="w-[min(92vw,560px)]"
    >
      <form
        onSubmit={(e) => {
          submit(e);
        }}
        className="space-y-3"
      >
        <Field label="Title">
          <input
            name="title"
            className={inputClass}
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
            maxLength={MAX_EVENT_TITLE}
            autoComplete="off"
            autoFocus
            required
          />
        </Field>
        <label
          htmlFor={allDayId}
          className="flex items-center gap-2.5 text-base"
        >
          <Checkbox
            id={allDayId}
            name="allDay"
            checked={form.allDay}
            onChange={(e) => set("allDay", e.target.checked)}
          />
          All day
        </label>
        <div className="grid grid-cols-2 gap-3">
          <Field label={form.allDay ? "First day" : "Starts"}>
            <div className="flex gap-1.5">
              <input
                type="date"
                name="startDate"
                className={cx(inputClass, "min-w-0")}
                value={form.startDate}
                onChange={(e) => set("startDate", e.target.value)}
                required
              />
              {!form.allDay && (
                <input
                  type="time"
                  name="startTime"
                  className={cx(inputClass, "w-[6.5rem] shrink-0")}
                  value={form.startTime}
                  onChange={(e) => set("startTime", e.target.value)}
                  required
                />
              )}
            </div>
          </Field>
          <Field label={form.allDay ? "Last day" : "Ends"}>
            <div className="flex gap-1.5">
              <input
                type="date"
                name="endDate"
                className={cx(inputClass, "min-w-0")}
                value={form.endDate}
                min={form.startDate}
                onChange={(e) => set("endDate", e.target.value)}
                required
              />
              {!form.allDay && (
                <input
                  type="time"
                  name="endTime"
                  className={cx(inputClass, "w-[6.5rem] shrink-0")}
                  value={form.endTime}
                  onChange={(e) => set("endTime", e.target.value)}
                  required
                />
              )}
            </div>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Repeats">
            <select
              name="repeat"
              className={cx(selectClass, "w-full")}
              value={form.repeat}
              onChange={(e) => {
                const next = e.target.value;

                if (isRepeat(next)) {
                  set("repeat", next);
                }
              }}
            >
              {REPEATS.map((r) => (
                <option key={r} value={r}>
                  {REPEAT_LABEL[r]}
                </option>
              ))}
            </select>
          </Field>
          {form.repeat !== "none" && (
            <Field label="Until" hint="Leave empty to repeat without end.">
              <input
                type="date"
                name="repeatUntil"
                className={inputClass}
                value={form.repeatUntil}
                min={form.startDate}
                onChange={(e) => set("repeatUntil", e.target.value)}
              />
            </Field>
          )}
        </div>
        <Field label="Place">
          <input
            name="location"
            className={inputClass}
            value={form.location}
            onChange={(e) => set("location", e.target.value)}
            maxLength={MAX_EVENT_TITLE}
            autoComplete="off"
          />
        </Field>
        <Field label="Note">
          <textarea
            name="description"
            className={textareaClass}
            rows={3}
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            maxLength={MAX_EVENT_TEXT}
          />
        </Field>
        {colleagues.length > 0 && (
          <fieldset>
            <legend className="text-muted mb-1 block text-sm font-medium">
              Invite
            </legend>
            <ul className="border-line max-h-36 space-y-0.5 overflow-y-auto rounded-md border p-1">
              {colleagues.map((c) => {
                const status = event?.attendees.find(
                  (a) => a.id === c.id
                )?.status;

                return (
                  <li key={c.id}>
                    <label className="hover:bg-hover flex h-7 items-center gap-2 rounded-md px-1.5 text-base">
                      <Checkbox
                        name="attendee"
                        value={c.id}
                        checked={form.attendees.includes(c.id)}
                        onChange={(e) =>
                          set(
                            "attendees",
                            e.target.checked
                              ? [...form.attendees, c.id]
                              : form.attendees.filter((id) => id !== c.id)
                          )
                        }
                      />
                      <Avatar name={c.name} size={16} />
                      <span className="min-w-0 flex-1 truncate">{c.name}</span>
                      {status && status !== "needs-action" && (
                        <Pill tone={STATUS_TONE[status]}>
                          {ATTENDEE_STATUS_LABEL[status]}
                        </Pill>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex items-center gap-2">
          {event && (
            <Button
              variant="ghost"
              onClick={() => {
                remove();
              }}
              disabled={busy}
              className="text-red"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={busy}>
              {event ? "Save" : "Add"}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
};
