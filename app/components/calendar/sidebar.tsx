import { Link, useHydrated, useLocation } from "@tanstack/react-router";
import {
  CalendarDays,
  CalendarPlus,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  ListTodo,
  Plus,
  SquareCheckBig,
} from "lucide-react";
import { useState } from "react";

import {
  addMonths,
  isCalendarView,
  isDayKey,
  monthGrid,
  parseDay,
  startOfMonth,
  todayKey,
} from "~/lib/calendar/calendar";
import type { CalendarView, DayKey } from "~/lib/calendar/calendar";
import { defined, isJsonObject, stringOrNull } from "~/lib/guards";

import { TaskDialog } from "../tasks/task-dialog";
import { cx } from "../ui";
import { EventDialog } from "./event-dialog";
import type { Colleague } from "./event-dialog";

const itemClass = (active: boolean) =>
  cx(
    "flex h-7 items-center gap-2 rounded-md px-2 text-base transition-colors duration-100",
    active ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg"
  );

/** A month to move by: its days link to the view on them; the arrows show another month. */
const MiniMonth = ({
  anchor,
  view,
}: {
  anchor: DayKey;
  view: CalendarView;
}) => {
  const [month, setMonth] = useState(() => startOfMonth(anchor));
  const [seenAnchor, setSeenAnchor] = useState(anchor);

  // Moving the view to another day brings the month to it, however the person had paged.
  if (seenAnchor !== anchor) {
    setSeenAnchor(anchor);
    setMonth(startOfMonth(anchor));
  }

  const days = monthGrid(month);
  const today = todayKey();
  const p = defined(parseDay(month), "the result of parse day");

  const title = new Date(`${month}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <div className="mt-4 px-1">
      <div className="mb-1 flex items-center px-1">
        <span className="text-subtle flex-1 text-xs font-medium">{title}</span>
        <button
          type="button"
          onClick={() => setMonth(addMonths(month, -1))}
          className="text-subtle hover:bg-hover hover:text-fg flex h-5 w-5 items-center justify-center rounded-md"
          aria-label="Previous month"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setMonth(addMonths(month, 1))}
          className="text-subtle hover:bg-hover hover:text-fg flex h-5 w-5 items-center justify-center rounded-md"
          aria-label="Next month"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="text-2xs text-subtle grid grid-cols-7 text-center">
        {days.slice(0, 7).map((day) => (
          <span key={day} className="h-5 leading-5" aria-hidden>
            {new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
              weekday: "narrow",
              timeZone: "UTC",
            })}
          </span>
        ))}
        {days.map((day) => {
          const inMonth =
            defined(parseDay(day), "the result of parse day").m === p.m;

          return (
            <Link
              key={day}
              to="/calendar"
              search={{ view: view === "week" ? undefined : view, date: day }}
              className={cx(
                "tnum mx-auto flex h-6 w-6 items-center justify-center rounded-full text-xs transition-colors hover:bg-hover",
                !inMonth && "text-faint",
                day === anchor && "bg-active text-fg",
                day === today && "font-semibold text-accent"
              )}
              aria-current={day === anchor ? "date" : undefined}
            >
              {defined(parseDay(day), "the result of parse day").d}
            </Link>
          );
        })}
      </div>
    </div>
  );
};

/** The address's `view` and `date`, each only when it is a string. */
const usePlannerSearch = () => {
  const { search } = useLocation();
  const view = isJsonObject(search) ? stringOrNull(search.view) : null;
  const date = isJsonObject(search) ? stringOrNull(search.date) : null;

  return { view: view ?? undefined, date: date ?? undefined };
};

/** The day the views are on: the address's, else the reader's today once hydrated (the server does not know the zone). */
const anchorOf = (
  date: string | undefined,
  hydrated: boolean
): DayKey | null => {
  if (isDayKey(date)) {
    return date;
  }

  return hydrated ? todayKey() : null;
};

/** The button that starts a new event on the calendar and a new task on the tasks' pages. */
const NewButton = ({
  onCalendar,
  onNew,
}: {
  onCalendar: boolean;
  onNew: () => void;
}) => (
  <div className="px-3 pb-3">
    <button
      type="button"
      onClick={onNew}
      className="bg-accent text-accent-fg hover:bg-accent-hover flex h-7 w-full items-center justify-center gap-1.5 rounded-md px-2.5 text-base font-medium shadow-[inset_0_1px_0_rgb(255_255_255/0.12),0_1px_1px_rgb(0_0_0/0.08)] transition-colors"
      title={onCalendar ? "New event (n)" : "New task (n)"}
    >
      {onCalendar ? (
        <CalendarPlus className="h-3.5 w-3.5" />
      ) : (
        <Plus className="h-3.5 w-3.5" />
      )}
      {onCalendar ? "New event" : "New task"}
    </button>
  </div>
);

const CalendarLinks = ({
  onCalendar,
  view,
  anchor,
}: {
  onCalendar: boolean;
  view: CalendarView;
  anchor: DayKey | null;
}) => (
  <ul className="space-y-px">
    <li>
      <Link
        to="/calendar"
        search={{ date: anchor ?? undefined }}
        className={itemClass(onCalendar && view === "week")}
        aria-current={onCalendar && view === "week" ? "page" : undefined}
      >
        <CalendarRange className="h-4 w-4 shrink-0" />
        <span className="flex-1 truncate">Week</span>
      </Link>
    </li>
    <li>
      <Link
        to="/calendar"
        search={{ view: "month", date: anchor ?? undefined }}
        className={itemClass(onCalendar && view === "month")}
        aria-current={onCalendar && view === "month" ? "page" : undefined}
      >
        <CalendarDays className="h-4 w-4 shrink-0" />
        <span className="flex-1 truncate">Month</span>
      </Link>
    </li>
  </ul>
);

const TaskLinks = ({
  onTasks,
  taskView,
}: {
  onTasks: boolean;
  taskView: "open" | "done";
}) => (
  <ul className="space-y-px">
    <li>
      <Link
        to="/tasks"
        search={{}}
        className={itemClass(onTasks && taskView === "open")}
        aria-current={onTasks && taskView === "open" ? "page" : undefined}
      >
        <ListTodo className="h-4 w-4 shrink-0" />
        <span className="flex-1 truncate">Tasks</span>
      </Link>
    </li>
    <li>
      <Link
        to="/tasks"
        search={{ view: "done" }}
        className={itemClass(onTasks && taskView === "done")}
        aria-current={onTasks && taskView === "done" ? "page" : undefined}
      >
        <SquareCheckBig className="h-4 w-4 shrink-0" />
        <span className="flex-1 truncate">Done</span>
      </Link>
    </li>
  </ul>
);

/**
 * The sidebar of Calendar and Tasks (#3111): New event or New task, the calendar's views and the tasks' lists, and
 * on the calendar a small month to move by.
 */
export const PlannerSidebar = ({
  module,
  colleagues,
  githubConnected,
}: {
  module: "calendar" | "tasks";
  colleagues: Colleague[];
  githubConnected: boolean;
}) => {
  const hydrated = useHydrated();
  const search = usePlannerSearch();
  const [newEvent, setNewEvent] = useState(false);
  const [newTask, setNewTask] = useState(false);
  const onCalendar = module === "calendar";
  const view: CalendarView = isCalendarView(search.view) ? search.view : "week";
  const taskView = search.view === "done" ? "done" : "open";
  const anchor = anchorOf(search.date, hydrated);

  return (
    <>
      <NewButton
        onCalendar={onCalendar}
        onNew={() => (onCalendar ? setNewEvent(true) : setNewTask(true))}
      />
      <nav
        className="flex-1 overflow-y-auto px-2 pb-2"
        aria-label="Calendar and tasks"
      >
        <div className="text-subtle mb-1 px-2 text-xs font-medium">
          Calendar
        </div>
        <CalendarLinks onCalendar={onCalendar} view={view} anchor={anchor} />
        <div className="text-subtle mt-4 mb-1 px-2 text-xs font-medium">
          Tasks
        </div>
        <TaskLinks onTasks={!onCalendar} taskView={taskView} />
        {onCalendar && anchor && <MiniMonth anchor={anchor} view={view} />}
      </nav>
      <EventDialog
        open={newEvent}
        event={null}
        colleagues={colleagues}
        onClose={() => setNewEvent(false)}
      />
      <TaskDialog
        open={newTask}
        task={null}
        today={hydrated ? todayKey() : "2026-01-01"}
        githubConnected={githubConnected}
        onClose={() => setNewTask(false)}
      />
    </>
  );
};
