import { Link, useHydrated, useNavigate } from "@tanstack/react-router";
import {
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  SquareCheck,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

import {
  CALENDAR_VIEWS,
  WORKDAY_START_HOUR,
  addDays,
  itemDays,
  lanes,
  localDay,
  minutesOn,
  monthGrid,
  parseDay,
  stepView,
  timeRange,
  todayKey,
  utcDay,
  viewTitle,
  weekDays,
} from "~/lib/calendar/calendar";
import type {
  CalendarItem,
  CalendarView,
  DayKey,
} from "~/lib/calendar/calendar";
import type {
  EventOccurrence,
  EventView,
} from "~/lib/calendar/calendar.server";
import { defined } from "~/lib/guards";
import { tasksHref } from "~/lib/tasks/tasks";
import type { TaskRow } from "~/lib/tasks/tasks";

import { useShortcuts } from "../keyboard";
import { Button, IconButton, ViewHeader, cx } from "../ui";
import { EventDialog, draftAt } from "./event-dialog";
import type { Colleague, EventDraft } from "./event-dialog";

export interface CalendarData {
  view: CalendarView;
  /** The day the view is on, as the address names it; null when it does not (the reader's today, then). */
  date: DayKey | null;
  events: EventOccurrence[];
  /** The reader's open tasks due in the range. */
  tasks: TaskRow[];
  colleagues: Colleague[];
}

const VIEW_LABEL: Record<CalendarView, string> = {
  week: "Week",
  month: "Month",
};

/** The height of an hour in the week grid. */
const HOUR_PX = 48;

/** Everything on the grid: the events' occurrences and the tasks on their due day. */
const buildItems = (data: CalendarData): CalendarItem[] => {
  const items: CalendarItem[] = data.events.map((e) => ({
    key: e.key,
    kind: e.mine ? "own" : "invited",
    title: e.title,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    eventId: e.id,
    href: null,
    declined: e.myStatus === "declined",
    tone: "neutral",
  }));

  for (const t of data.tasks) {
    if (t.dueOn) {
      items.push({
        key: `task:${t.id}`,
        kind: "task",
        title: t.title,
        start: `${t.dueOn}T00:00:00.000Z`,
        end: `${addDays(t.dueOn, 1)}T00:00:00.000Z`,
        allDay: true,
        eventId: null,
        href: tasksHref(),
        declined: false,
        tone: t.priority === "high" ? "amber" : "neutral",
      });
    }
  }

  return items;
};

const TONE_CLASS: Record<
  CalendarItem["kind"],
  Record<CalendarItem["tone"], string>
> = {
  own: {
    neutral: "bg-accent text-accent-fg hover:bg-accent-hover",
    amber: "bg-accent text-accent-fg",
  },
  invited: {
    neutral:
      "border border-accent/40 bg-accent-soft text-accent hover:border-accent",
    amber: "border border-accent/40 bg-accent-soft text-accent",
  },
  task: {
    neutral: "border border-line bg-elevated text-fg hover:border-line-strong",
    amber: "border border-amber/40 bg-amber-soft text-amber",
  },
};

const Chip = ({
  item,
  onOpen,
  className,
  detail,
  style,
}: {
  item: CalendarItem;
  onOpen: (item: CalendarItem) => void;
  className?: string;
  detail?: string;
  /** A timed item's place in its day column. */
  style?: CSSProperties;
}) => (
  <button
    type="button"
    style={style}
    onClick={(e) => {
      e.stopPropagation();
      onOpen(item);
    }}
    className={cx(
      "flex w-full min-w-0 items-center gap-1 overflow-hidden rounded-[4px] px-1.5 text-left text-xs leading-5 transition-colors",
      TONE_CLASS[item.kind][item.tone],
      item.declined && "line-through opacity-60",
      className
    )}
    title={detail ? `${item.title} · ${detail}` : item.title}
  >
    {item.kind === "task" && <SquareCheck className="h-3 w-3 shrink-0" />}
    <span className="min-w-0 flex-1 truncate">{item.title}</span>
  </button>
);

const dayLabel = (day: DayKey, style: "weekday" | "number"): string => {
  const p = defined(parseDay(day), "the result of parse day");
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d));

  return style === "weekday"
    ? d.toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" })
    : String(p.d);
};

/** The minutes since midnight now, in the reader's zone, moved on every minute; null before hydration. */
const useNowMinutes = () => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);

    return () => clearInterval(timer);
  }, []);

  return {
    day: localDay(now),
    minutes: now.getHours() * 60 + now.getMinutes(),
  };
};

/** The moment a day begins in the reader's zone, `minutes` on. */
const dayDate = (day: DayKey, minutes = 0): Date => {
  const p = defined(parseDay(day), "the result of parse day");

  return new Date(p.y, p.m - 1, p.d, 0, minutes);
};

const hourLabel = (h: number) =>
  new Date(2026, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" });

const WeekGrid = ({
  anchor,
  items,
  onOpen,
  onNew,
}: {
  anchor: DayKey;
  items: CalendarItem[];
  onOpen: (item: CalendarItem) => void;
  onNew: (start: Date, allDay?: boolean) => void;
}) => {
  const days = weekDays(anchor);
  const now = useNowMinutes();
  const scroller = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<DayKey | null>(null);
  useEffect(() => {
    if (scrolledFor.current === anchor) {
      return;
    }

    scrolledFor.current = anchor;
    scroller.current?.scrollTo({ top: WORKDAY_START_HOUR * HOUR_PX - 8 });
  }, [anchor]);

  const allDay = new Map<DayKey, CalendarItem[]>();
  const timed = new Map<DayKey, CalendarItem[]>();

  for (const item of items) {
    const spansDays = !item.allDay && itemDays(item).length > 1;

    if (item.allDay || spansDays) {
      for (const day of itemDays(item)) {
        allDay.set(day, [...(allDay.get(day) ?? []), item]);
      }
    } else {
      for (const day of itemDays(item)) {
        timed.set(day, [...(timed.get(day) ?? []), item]);
      }
    }
  }

  const hours = Array.from({ length: 24 }, (_, h) => h);

  return (
    <div ref={scroller} className="flex-1 overflow-auto">
      <div className="min-w-[720px]">
        <div className="border-line bg-bg sticky top-0 z-20 grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b">
          <div />
          {days.map((day) => {
            const today = day === now.day;

            return (
              <div
                key={day}
                className="flex flex-col items-center gap-0.5 py-1.5 text-center"
              >
                <span className="text-subtle text-xs tracking-wide uppercase">
                  {dayLabel(day, "weekday")}
                </span>
                <span
                  className={cx(
                    "tnum flex h-6 w-6 items-center justify-center rounded-full text-md font-medium",
                    today ? "bg-accent text-accent-fg" : "text-fg"
                  )}
                >
                  {dayLabel(day, "number")}
                </span>
              </div>
            );
          })}
          <div className="text-2xs text-subtle py-1 pr-1 text-right">
            all day
          </div>
          {days.map((day) => (
            <div
              key={day}
              className="border-line relative min-h-6 space-y-0.5 border-l px-0.5 pb-1"
            >
              <button
                type="button"
                className="absolute inset-0 w-full rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-(--ring)"
                aria-label={`New all-day event on ${day}`}
                onClick={() => onNew(dayDate(day), true)}
              />
              {(allDay.get(day) ?? []).map((item) => (
                <Chip
                  key={item.key}
                  item={item}
                  onOpen={onOpen}
                  className="relative z-10"
                />
              ))}
            </div>
          ))}
        </div>
        <div className="relative grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]">
          <div className="relative" style={{ height: 24 * HOUR_PX }}>
            {hours.map((h) => (
              <div
                key={h}
                className="text-2xs text-subtle absolute right-1.5 -translate-y-1/2"
                style={{ top: h * HOUR_PX }}
              >
                {h ? hourLabel(h) : ""}
              </div>
            ))}
          </div>
          {days.map((day) => {
            const laid = lanes(timed.get(day) ?? []);

            return (
              <div
                key={day}
                className="border-line relative border-l"
                style={{ height: 24 * HOUR_PX }}
              >
                {hours.map((h) => (
                  <div
                    key={h}
                    className="border-line/70 absolute inset-x-0 border-t"
                    style={{ top: h * HOUR_PX }}
                  />
                ))}
                <button
                  type="button"
                  className="absolute inset-0 w-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-(--ring)"
                  aria-label={`New event on ${day}`}
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();

                    // A press lands on a half hour; Enter on the day lands on the workday's start.
                    const minutes =
                      e.clientY > 0
                        ? Math.floor(
                            ((e.clientY - rect.top) / rect.height) * 48
                          ) * 30
                        : WORKDAY_START_HOUR * 60 + 120;

                    onNew(dayDate(day, minutes));
                  }}
                />
                {laid.map(({ item, lane, lanes: count }) => {
                  const [from, to] = minutesOn(item, day);
                  const height = Math.max(to - from, 20);

                  return (
                    <Chip
                      key={item.key}
                      item={item}
                      onOpen={onOpen}
                      detail={timeRange(item.start, item.end)}
                      className="absolute z-10 items-start overflow-hidden py-0.5 leading-4"
                      style={{
                        top: (from / 60) * HOUR_PX,
                        height: (height / 60) * HOUR_PX - 2,
                        left: `calc(${(lane / count) * 100}% + 2px)`,
                        width: `calc(${100 / count}% - 4px)`,
                      }}
                    />
                  );
                })}
                {day === now.day && (
                  <div
                    aria-hidden
                    className="border-red pointer-events-none absolute inset-x-0 z-20 border-t-2"
                    style={{ top: (now.minutes / 60) * HOUR_PX }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

const MONTH_CHIPS = 3;

const MonthGrid = ({
  anchor,
  items,
  onOpen,
  onNew,
  onDay,
}: {
  anchor: DayKey;
  items: CalendarItem[];
  onOpen: (item: CalendarItem) => void;
  onNew: (start: Date, allDay?: boolean) => void;
  onDay: (day: DayKey) => void;
}) => {
  const days = monthGrid(anchor);
  const month = defined(parseDay(anchor), "the result of parse day").m;
  const today = todayKey();
  const byDay = new Map<DayKey, CalendarItem[]>();

  for (const item of items) {
    for (const day of itemDays(item)) {
      byDay.set(day, [...(byDay.get(day) ?? []), item]);
    }
  }

  for (const list of byDay.values()) {
    list.sort(
      (a, b) =>
        Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start)
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="border-line grid min-w-[720px] grid-cols-7 border-b">
        {days.slice(0, 7).map((day) => (
          <div
            key={day}
            className="text-subtle py-1.5 text-center text-xs tracking-wide uppercase"
          >
            {dayLabel(day, "weekday")}
          </div>
        ))}
      </div>
      <div className="grid min-h-full min-w-[720px] auto-rows-[minmax(6.5rem,1fr)] grid-cols-7">
        {days.map((day) => {
          const list = byDay.get(day) ?? [];
          const shown = list.slice(0, MONTH_CHIPS);

          const inMonth =
            defined(parseDay(day), "the result of parse day").m === month;

          return (
            <div
              key={day}
              className={cx(
                "relative border-b border-r border-line p-1",
                !inMonth && "bg-sidebar text-subtle"
              )}
            >
              <button
                type="button"
                className="absolute inset-0 w-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-(--ring)"
                aria-label={`New all-day event on ${day}`}
                onClick={() => onNew(dayDate(day), true)}
              />
              <div className="relative z-10 mb-0.5 flex justify-end">
                <button
                  type="button"
                  onClick={() => onDay(day)}
                  className={cx(
                    "tnum flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-sm hover:bg-hover",
                    day === today &&
                      "bg-accent font-medium text-accent-fg hover:bg-accent-hover"
                  )}
                  title="Open the week"
                >
                  {dayLabel(day, "number")}
                </button>
              </div>
              <div className="relative z-10 space-y-0.5">
                {shown.map((item) => (
                  <Chip
                    key={item.key}
                    item={item}
                    onOpen={onOpen}
                    detail={
                      item.allDay ? undefined : timeRange(item.start, item.end)
                    }
                  />
                ))}
                {list.length > shown.length && (
                  <button
                    type="button"
                    onClick={() => onDay(day)}
                    className="text-muted hover:text-fg px-1.5 text-xs"
                  >
                    +{list.length - shown.length} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/**
 * The calendar: a week of hours or a month of days, with the reader's events, the ones they are invited to and their
 * tasks on their due day. Everything is placed in the reader's zone, so the grid renders once hydrated. A press on
 * an empty slot starts an event there; on an item, opens it.
 */
export const CalendarPage = ({ data }: { data: CalendarData }) => {
  const hydrated = useHydrated();
  const navigate = useNavigate();
  const { view, events, colleagues } = data;
  const anchor = data.date ?? (hydrated ? todayKey() : null);

  const [dialog, setDialog] = useState<{
    event: EventView | null;
    draft: EventDraft | null;
  } | null>(null);

  const items = useMemo(
    () => (hydrated ? buildItems(data) : []),
    [hydrated, data]
  );

  // Without a day in the address the server took UTC's today; the reader's own day decides the week.
  useEffect(() => {
    if (hydrated && !data.date) {
      void navigate({
        to: "/calendar",
        search: { view: view === "week" ? undefined : view, date: todayKey() },
        replace: true,
      });
    }
  }, [hydrated, data.date, view, navigate]);

  const go = (day: DayKey, to: CalendarView = view) => {
    void navigate({
      to: "/calendar",
      search: { view: to === "week" ? undefined : to, date: day },
    });
  };

  const open = (item: CalendarItem) => {
    if (item.eventId) {
      const event = events.find((e) => e.id === item.eventId);

      if (event) {
        setDialog({ event, draft: null });
      }
    } else if (item.href) {
      void navigate({ href: item.href });
    }
  };

  const newAt = (start: Date, allDay = false) =>
    setDialog({ event: null, draft: draftAt(start, allDay) });

  // A move from the shown day waits for there to be one: until hydrated there may be none.
  const step = (by: -1 | 1) => {
    if (anchor) {
      go(stepView(view, anchor, by));
    }
  };

  const showAs = (to: CalendarView) => {
    if (anchor) {
      go(anchor, to);
    }
  };

  useShortcuts([
    { keys: "n", run: () => newAt(new Date()) },
    { keys: "t", run: () => go(todayKey()) },
    { keys: "[", run: () => step(-1) },
    { keys: "]", run: () => step(1) },
    { keys: "w", run: () => showAs("week") },
    { keys: "m", run: () => showAs("month") },
  ]);

  let grid: React.ReactNode = <div className="flex-1" aria-busy />;

  if (anchor && hydrated) {
    grid =
      view === "month" ? (
        <MonthGrid
          anchor={anchor}
          items={items}
          onOpen={open}
          onNew={newAt}
          onDay={(d) => go(d, "week")}
        />
      ) : (
        <WeekGrid anchor={anchor} items={items} onOpen={open} onNew={newAt} />
      );
  }

  return (
    <>
      <ViewHeader
        title={anchor ? viewTitle(view, anchor) : "Calendar"}
        left={
          <div className="flex items-center gap-0.5">
            <IconButton label="Previous" size="sm" onClick={() => step(-1)}>
              <ChevronLeft className="h-4 w-4" />
            </IconButton>
            <IconButton label="Next" size="sm" onClick={() => step(1)}>
              <ChevronRight className="h-4 w-4" />
            </IconButton>
            <Button size="sm" onClick={() => go(todayKey())} title="Today (t)">
              Today
            </Button>
          </div>
        }
      >
        <div className="bg-hover flex items-center gap-0.5 rounded-md p-0.5">
          {CALENDAR_VIEWS.map((v) => (
            <Link
              key={v}
              to="/calendar"
              search={{
                view: v === "week" ? undefined : v,
                date: anchor ?? undefined,
              }}
              replace
              className={cx(
                "h-6 rounded-[5px] px-2 text-sm leading-6 transition-colors duration-100",
                view === v
                  ? "bg-elevated text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08)]"
                  : "text-muted hover:text-fg"
              )}
              aria-current={view === v ? "page" : undefined}
              title={`${VIEW_LABEL[v]} (${v[0]})`}
            >
              {VIEW_LABEL[v]}
            </Link>
          ))}
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => newAt(new Date())}
          title="New event (n)"
        >
          <CalendarPlus className="h-3.5 w-3.5" />
          New event
        </Button>
      </ViewHeader>
      {grid}
      <EventDialog
        open={dialog !== null}
        event={dialog?.event ?? null}
        draft={dialog?.draft ?? null}
        colleagues={colleagues}
        onClose={() => setDialog(null)}
      />
    </>
  );
};

/** The first day of the range a view needs, and the day after its last, with a day's leeway each side for the zone. */
export const viewRange = (view: CalendarView, day: DayKey) => {
  const days = view === "month" ? monthGrid(day) : weekDays(day);

  return {
    from: addDays(defined(days[0], "the first item"), -1),
    to: addDays(defined(days.at(-1), "the item"), 2),
  };
};

/** The reader's today as the server sees it: UTC's. */
export const serverToday = () => utcDay(new Date());
