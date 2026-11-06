import { Dialog, Kbd } from "./ui";

const GROUPS: { title: string; keys: [string[], string][] }[] = [
  {
    title: "Go to",
    keys: [
      [["g", "i"], "Inbox"],
      [["g", "s"], "Starred"],
      [["g", "b"], "Snoozed"],
      [["g", "t"], "Sent"],
      [["g", "d"], "Drafts"],
      [["g", "a"], "All mail"],
      [["g", "p"], "Spam"],
      [["g", "x"], "Trash"],
      [["g", "f"], "Drive"],
      [["g", "c"], "Calendar"],
      [["g", "k"], "Tasks"],
      [["g", "h"], "Assistant"],
      [["g", ","], "Settings"],
    ],
  },
  {
    title: "Anywhere",
    keys: [
      [["c"], "Compose"],
      [["/"], "Search"],
      [["⌘", "B"], "Sidebar"],
      [["⌘", "J"], "Assistant"],
      [["z"], "Undo the last action"],
      [["?"], "This list"],
      [["Esc"], "Leave a field, close a menu"],
    ],
  },
  {
    title: "In a list",
    keys: [
      [["j"], "Next conversation"],
      [["k"], "Previous conversation"],
      [["Enter"], "Open"],
      [["x"], "Select"],
      [["*", "a"], "Select all on the page"],
      [["*", "n"], "Select none"],
      [["*", "u"], "Select unread"],
    ],
  },
  {
    title: "On a conversation (open or selected)",
    keys: [
      [["e"], "Archive"],
      [["#"], "Trash"],
      [["!"], "Spam"],
      [["s"], "Star"],
      [["b"], "Snooze menu"],
      [["l"], "Label menu"],
      [["m"], "Mute"],
      [["I"], "Mark read"],
      [["U"], "Mark unread"],
      [["u"], "Back to the list"],
      [["r"], "Reply"],
      [["a"], "Reply all"],
      [["f"], "Forward"],
      [[";"], "Expand or collapse all"],
    ],
  },
  {
    title: "In Drive",
    keys: [
      [["n"], "New folder"],
      [["u"], "Upload files"],
      [["Enter"], "Open"],
      [["x"], "Select"],
      [["s"], "Star"],
      [["r"], "Rename"],
      [["m"], "Move"],
      [["#"], "Trash, or delete from the trash"],
      [["⌫"], "Up a level"],
    ],
  },
  {
    title: "In Calendar and Tasks",
    keys: [
      [["n"], "New event, or new task"],
      [["t"], "Today"],
      [["["], "Previous week or month"],
      [["]"], "Next week or month"],
      [["w"], "Week view"],
      [["m"], "Month view"],
    ],
  },
  {
    title: "Writing",
    keys: [
      [["⌘", "Enter"], "Send"],
      [["⌘", "B"], "Bold"],
      [["⌘", "I"], "Italic"],
      [["⌘", "U"], "Underline"],
      [["⌘", "K"], "Link"],
    ],
  },
];

/** The keyboard shortcuts, as `?` shows them. */
export const ShortcutsHelp = ({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) => (
  <Dialog
    open={open}
    onClose={onClose}
    title="Keyboard shortcuts"
    className="w-[min(92vw,720px)]"
  >
    <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
      {GROUPS.map((g) => (
        <section key={g.title}>
          <h3 className="text-subtle mb-1.5 text-xs font-medium tracking-wide uppercase">
            {g.title}
          </h3>
          <dl className="space-y-1">
            {g.keys.map(([keys, what]) => (
              <div
                key={what}
                className="flex items-center justify-between gap-3 text-base"
              >
                <dt className="text-muted">{what}</dt>
                <dd className="flex shrink-0 items-center gap-1">
                  {keys.map((k, i) => (
                    <span
                      key={`${what}-${k}`}
                      className="flex items-center gap-1"
                    >
                      {i > 0 && keys.length === 2 && keys[0].length === 1 && (
                        <span className="text-subtle text-xs">then</span>
                      )}
                      <Kbd>{k}</Kbd>
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  </Dialog>
);
