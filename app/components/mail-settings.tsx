import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useAction } from "~/lib/action";
import { mailSettingsAction } from "~/lib/mail/actions";
import type { SettingsResult } from "~/lib/mail/actions";
import { describeFilter } from "~/lib/mail/filters";
import type { FilterView } from "~/lib/mail/filters.server";
import type { LabelRef } from "~/lib/mail/folders";
import { PAGE_SIZE_CHOICES, UNDO_SEND_CHOICES } from "~/lib/mail/preferences";
import type { MailPreferences } from "~/lib/mail/preferences";
import { describeSender } from "~/lib/mail/spam";

import { ColorPalette, LabelChip } from "./labels";
import { MailImport } from "./mail-import";
import type { ImportSettings } from "./mail-import";
import { PgpSettings } from "./pgp-settings";
import type { PgpSettingsData } from "./pgp-settings";
import {
  Button,
  Checkbox,
  Field,
  IconButton,
  Notice,
  Pill,
  Section,
  cx,
  inputClass,
  selectClass,
  textareaClass,
} from "./ui";

export interface MailSettingsData {
  preferences: MailPreferences;
  labels: LabelRef[];
  filters: FilterView[];
  spam: {
    senders: { sender: string; verdict: "block" | "allow" }[];
    /** How many messages the filter learnt as spam and as kept mail. */
    learnt: { spam: number; ham: number };
    mailDomain: string;
  };
  /** The senders whose images from the web always load, an address or `@domain`. */
  imageSenders: string[];
  vacation: {
    on: boolean;
    subject: string;
    text: string;
    from: string | null;
    until: string | null;
  };
  imports: ImportSettings;
  pgp: PgpSettingsData;
}

const Feedback = ({
  result,
  error,
}: {
  result?: SettingsResult;
  error: string | null;
}) => {
  const message = (result && !result.ok && result.error) || error;

  if (message) {
    return <Notice tone="error">{message}</Notice>;
  }

  if (result?.ok && result.message) {
    return <Notice tone="success">{result.message}</Notice>;
  }

  return null;
};

/** Calls `then` in the render that first sees a saved answer of an action: a form that closes, or starts afresh, once its save went through. */
const useWhenSaved = (data: SettingsResult | undefined, then: () => void) => {
  const [seen, setSeen] = useState(data);

  if (seen !== data) {
    setSeen(data);

    if (data?.ok) {
      then();
    }
  }
};

const Preferences = ({ preferences }: { preferences: MailPreferences }) => {
  const act = useAction(mailSettingsAction);

  return (
    <Section title="Reading and writing">
      <act.Form className="space-y-4 p-4">
        <Field
          label="Layout"
          hint="Split shows the list beside the open conversation on a wide screen; full width shows one at a time."
        >
          <select
            name="layout"
            defaultValue={preferences.layout}
            className={cx(selectClass, "w-full")}
          >
            <option value="split">
              Split: the list beside the conversation
            </option>
            <option value="full">
              Full width: the list, then the conversation
            </option>
          </select>
        </Field>
        <Field
          label="Undo send"
          hint="How long a message waits before it leaves, so you can take it back from the toast."
        >
          <select
            name="undoSendSeconds"
            defaultValue={String(preferences.undoSendSeconds)}
            className={cx(selectClass, "w-full")}
          >
            {UNDO_SEND_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "Send at once" : `${n} seconds`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Conversations per page">
          <select
            name="pageSize"
            defaultValue={String(preferences.pageSize)}
            className={cx(selectClass, "w-full")}
          >
            {PAGE_SIZE_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        <Feedback result={act.data} error={act.error} />
        <Button
          type="submit"
          name="intent"
          value="preferences"
          variant="primary"
          loading={act.state === "submitting"}
        >
          Save
        </Button>
      </act.Form>
    </Section>
  );
};

const LabelRow = ({ label }: { label: LabelRef }) => {
  const act = useAction(mailSettingsAction);
  const [editing, setEditing] = useState(false);
  const [color, setColor] = useState(label.color);
  useWhenSaved(act.data, () => setEditing(false));

  if (editing) {
    return (
      <li className="p-4">
        <act.Form className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="id" value={label.id} />
          <Field label="Name" className="min-w-48 flex-1">
            <input
              name="name"
              defaultValue={label.name}
              required
              maxLength={40}
              autoFocus
              className={inputClass}
            />
          </Field>
          <div>
            <span className="text-muted mb-1 block text-sm font-medium">
              Colour
            </span>
            <ColorPalette name="color" value={color} onChange={setColor} />
          </div>
          <Button
            type="submit"
            name="intent"
            value="label-update"
            variant="primary"
            loading={act.state === "submitting"}
          >
            Save
          </Button>
          <Button variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Feedback result={act.data} error={act.error} />
        </act.Form>
      </li>
    );
  }

  return (
    <li className="flex items-center gap-3 px-4 py-2">
      <LabelChip label={label} />
      <span className="flex-1" />
      <IconButton
        size="sm"
        label={`Rename ${label.name}`}
        onClick={() => setEditing(true)}
      >
        <Pencil className="h-3.5 w-3.5" />
      </IconButton>
      <act.Form>
        <input type="hidden" name="id" value={label.id} />
        <IconButton
          size="sm"
          type="submit"
          name="intent"
          value="label-delete"
          label={`Delete ${label.name}`}
          className="hover:text-red"
          onClick={(e) => {
            if (
              // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
              !confirm(
                `Delete the label "${label.name}"? It leaves every conversation it is on.`
              )
            ) {
              e.preventDefault();
            }
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </IconButton>
      </act.Form>
    </li>
  );
};

const Labels = ({ labels }: { labels: LabelRef[] }) => {
  const create = useAction(mailSettingsAction);
  const [adding, setAdding] = useState(false);
  const [color, setColor] = useState<LabelRef["color"]>("gray");
  useWhenSaved(create.data, () => setAdding(false));

  return (
    <Section
      title="Labels"
      actions={
        <Button
          size="sm"
          onClick={() => setAdding((a) => !a)}
          aria-expanded={adding}
        >
          <Plus className="h-3.5 w-3.5" />
          Add label
        </Button>
      }
    >
      {adding && (
        <create.Form className="border-line flex flex-wrap items-end gap-3 border-b p-4">
          <Field label="Name" className="min-w-48 flex-1">
            <input
              name="name"
              required
              maxLength={40}
              autoFocus
              className={inputClass}
            />
          </Field>
          <div>
            <span className="text-muted mb-1 block text-sm font-medium">
              Colour
            </span>
            <ColorPalette name="color" value={color} onChange={setColor} />
          </div>
          <Button
            type="submit"
            name="intent"
            value="label-create"
            variant="primary"
            loading={create.state === "submitting"}
          >
            Add
          </Button>
          <Feedback result={create.data} error={create.error} />
        </create.Form>
      )}
      {labels.length ? (
        <ul className="divide-line divide-y">
          {labels.map((l) => (
            <LabelRow key={l.id} label={l} />
          ))}
        </ul>
      ) : (
        <p className="text-muted p-4 text-base">
          No labels yet. A label marks conversations across folders; filters can
          put one on mail as it arrives.
        </p>
      )}
    </Section>
  );
};

const FilterForm = ({
  filter,
  labels,
  onDone,
}: {
  filter?: FilterView;
  labels: LabelRef[];
  onDone: () => void;
}) => {
  const act = useAction(mailSettingsAction);
  const id = useId();
  const c = filter?.conditions ?? {};
  const a = filter?.actions ?? {};
  // The latest `onDone`, which the effect below calls without running again for it.
  const done = useRef(onDone);

  useEffect(() => {
    done.current = onDone;
  });

  // The form closes once the save went through; an error keeps it open.
  useEffect(() => {
    if (act.data?.ok) {
      done.current();
    }
  }, [act.data]);

  return (
    <act.Form className="border-line space-y-3 border-b p-4">
      {filter && <input type="hidden" name="id" value={filter.id} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="From"
          hint="Part of an address or a name; several with commas."
        >
          <input
            name="from"
            defaultValue={c.from ?? ""}
            className={inputClass}
          />
        </Field>
        <Field label="To">
          <input name="to" defaultValue={c.to ?? ""} className={inputClass} />
        </Field>
        <Field label="Subject has">
          <input
            name="subject"
            defaultValue={c.subject ?? ""}
            className={inputClass}
          />
        </Field>
        <Field label="Has the words">
          <input
            name="words"
            defaultValue={c.words ?? ""}
            className={inputClass}
          />
        </Field>
      </div>
      <label className="text-fg flex items-center gap-2.5 text-base">
        <Checkbox name="hasAttachment" defaultChecked={!!c.hasAttachment} />
        Has an attachment
      </label>
      <div className="text-muted text-sm font-medium">Then</div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-fg flex items-center gap-2.5 text-base">
          <Checkbox name="skipInbox" defaultChecked={!!a.skipInbox} />
          Skip the inbox (archive it)
        </label>
        <label className="text-fg flex items-center gap-2.5 text-base">
          <Checkbox name="markRead" defaultChecked={!!a.markRead} />
          Mark as read
        </label>
        <label className="text-fg flex items-center gap-2.5 text-base">
          <Checkbox name="star" defaultChecked={!!a.star} />
          Star it
        </label>
        <label className="text-fg flex items-center gap-2.5 text-base">
          <Checkbox name="trash" defaultChecked={!!a.trash} />
          Move to the trash
        </label>
        <label className="text-fg flex items-center gap-2.5 text-base">
          <Checkbox name="spam" defaultChecked={!!a.spam} />
          Mark as spam
        </label>
        <label className="text-fg flex items-center gap-2.5 text-base">
          <Checkbox name="neverSpam" defaultChecked={!!a.neverSpam} />
          Never send it to Spam
        </label>
        <label
          className="text-fg flex items-center gap-2.5 text-base"
          htmlFor={`${id}-label`}
        >
          <span className="shrink-0">Apply the label</span>
          <select
            id={`${id}-label`}
            name="labelId"
            defaultValue={a.labelId ?? ""}
            className={cx(selectClass, "min-w-0 flex-1")}
          >
            <option value="">None</option>
            {labels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Feedback result={act.data} error={act.error} />
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          name="intent"
          value="filter-save"
          variant="primary"
          loading={act.state === "submitting"}
        >
          {filter ? "Save" : "Add filter"}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          <X className="h-3.5 w-3.5" />
          Cancel
        </Button>
      </div>
    </act.Form>
  );
};

const FilterRow = ({
  filter: f,
  labels,
  first,
  last,
  describe,
}: {
  filter: FilterView;
  labels: LabelRef[];
  first: boolean;
  last: boolean;
  describe: () => { when: string; does: string };
}) => {
  const act = useAction(mailSettingsAction);
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <FilterForm filter={f} labels={labels} onDone={() => setEditing(false)} />
    );
  }

  const { when, does } = describe();

  return (
    <li className="flex items-start gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1 text-base">
        <div className="text-fg">
          <span className="text-subtle">When </span>
          {when}
        </div>
        <div className="text-muted">
          <span className="text-subtle">then </span>
          {does}
        </div>
      </div>
      <act.Form className="flex items-center gap-0.5">
        <input type="hidden" name="id" value={f.id} />
        <input type="hidden" name="direction" value="up" />
        <IconButton
          size="sm"
          type="submit"
          name="intent"
          value="filter-move"
          label="Move up"
          disabled={first}
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </IconButton>
      </act.Form>
      <act.Form className="flex items-center gap-0.5">
        <input type="hidden" name="id" value={f.id} />
        <input type="hidden" name="direction" value="down" />
        <IconButton
          size="sm"
          type="submit"
          name="intent"
          value="filter-move"
          label="Move down"
          disabled={last}
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </IconButton>
      </act.Form>
      <IconButton
        size="sm"
        label="Edit filter"
        onClick={() => setEditing(true)}
      >
        <Pencil className="h-3.5 w-3.5" />
      </IconButton>
      <act.Form>
        <input type="hidden" name="id" value={f.id} />
        <IconButton
          size="sm"
          type="submit"
          name="intent"
          value="filter-delete"
          label="Delete filter"
          className="hover:text-red"
          onClick={(e) => {
            // oxlint-disable-next-line eslint/no-alert -- destructive action requires user confirmation
            if (!confirm("Delete this filter?")) {
              e.preventDefault();
            }
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </IconButton>
      </act.Form>
    </li>
  );
};

const Filters = ({
  filters,
  labels,
}: {
  filters: FilterView[];
  labels: LabelRef[];
}) => {
  const [adding, setAdding] = useState(false);

  const labelName = (id: string) =>
    labels.find((l) => l.id === id)?.name ?? null;

  return (
    <Section
      title="Filters"
      actions={
        <Button
          size="sm"
          onClick={() => setAdding((a) => !a)}
          aria-expanded={adding}
        >
          <Plus className="h-3.5 w-3.5" />
          Add filter
        </Button>
      }
    >
      {adding && <FilterForm labels={labels} onDone={() => setAdding(false)} />}
      {filters.length ? (
        <ul className="divide-line divide-y">
          {filters.map((f, i) => (
            <FilterRow
              key={f.id}
              filter={f}
              labels={labels}
              first={i === 0}
              last={i === filters.length - 1}
              describe={() =>
                describeFilter(f.conditions, f.actions, labelName)
              }
            />
          ))}
        </ul>
      ) : (
        <p className="text-muted p-4 text-base">
          No filters yet. A filter runs on every message that arrives, in this
          order: it can keep mail out of the inbox, mark it read, star it, label
          it, send it to the trash or the spam folder, or keep it out of the
          spam folder whatever the spam filter thinks.
        </p>
      )}
    </Section>
  );
};

const SenderRow = ({
  sender: s,
}: {
  sender: MailSettingsData["spam"]["senders"][number];
}) => {
  const act = useAction(mailSettingsAction);
  const who = describeSender(s.sender);

  return (
    <li className="flex items-center gap-3 px-4 py-2">
      <Pill tone={s.verdict === "block" ? "red" : "accent"}>
        {s.verdict === "block" ? "Blocked" : "Never spam"}
      </Pill>
      <span className="text-fg min-w-0 flex-1 truncate text-base">{who}</span>
      <act.Form>
        <input type="hidden" name="sender" value={s.sender} />
        <IconButton
          size="sm"
          type="submit"
          name="intent"
          value="sender-remove"
          label={`Remove ${who}`}
          className="hover:text-red"
        >
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </act.Form>
    </li>
  );
};

const Spam = ({ spam }: { spam: MailSettingsData["spam"] }) => {
  const add = useAction(mailSettingsAction);
  // A fresh form once a sender went on the list, so the field is empty for the next.
  const [round, setRound] = useState(0);
  useWhenSaved(add.data, () => setRound((n) => n + 1));
  const { learnt } = spam;

  return (
    <Section title="Spam">
      <div className="space-y-3 p-4">
        <p className="text-muted text-base">
          Mail that looks like spam goes to the spam folder, with the reasons on
          it: what Cloudflare&apos;s checks found, mail that claims to come from{" "}
          {spam.mailDomain} but was sent elsewhere, programs among the files,
          links that show one site and go to another. Mail from people you wrote
          to never goes there. &ldquo;Report spam&rdquo; and &ldquo;Not
          spam&rdquo; teach the filter what you call spam
          {learnt.spam + learnt.ham > 0
            ? `; so far it learnt from ${learnt.spam} ${learnt.spam === 1 ? "message" : "messages"} of spam and ${learnt.ham} you kept.`
            : "."}{" "}
          Block a sender, or everyone at a domain, to send their mail to Spam;
          or say it is never spam.
        </p>
        <add.Form key={round} className="flex flex-wrap items-end gap-2">
          <Field label="Sender" className="min-w-56 flex-1">
            <input
              name="sender"
              required
              maxLength={254}
              placeholder="name@example.com or example.com"
              className={inputClass}
            />
          </Field>
          <Button
            type="submit"
            name="intent"
            value="sender-block"
            loading={add.state === "submitting"}
          >
            Block
          </Button>
          <Button type="submit" name="intent" value="sender-allow">
            Never spam
          </Button>
        </add.Form>
        <Feedback result={add.data} error={add.error} />
      </div>
      {spam.senders.length > 0 && (
        <ul className="divide-line border-line divide-y border-t">
          {spam.senders.map((s) => (
            <SenderRow key={s.sender} sender={s} />
          ))}
        </ul>
      )}
    </Section>
  );
};

const ImageSenderRow = ({ sender }: { sender: string }) => {
  const act = useAction(mailSettingsAction);
  const who = describeSender(sender);

  return (
    <li className="flex items-center gap-3 px-4 py-2">
      <span className="text-fg min-w-0 flex-1 truncate text-base">{who}</span>
      <act.Form>
        <input type="hidden" name="sender" value={sender} />
        <IconButton
          size="sm"
          type="submit"
          name="intent"
          value="image-sender-remove"
          label={`Remove ${who}`}
          className="hover:text-red"
        >
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </act.Form>
    </li>
  );
};

const Images = ({ senders }: { senders: string[] }) => {
  const add = useAction(mailSettingsAction);
  // A fresh form once a sender went on the list, so the field is empty for the next.
  const [round, setRound] = useState(0);
  useWhenSaved(add.data, () => setRound((n) => n + 1));

  return (
    <Section title="Images">
      <div className="space-y-3 p-4">
        <p className="text-muted text-base">
          Images from the web wait for &ldquo;Load images&rdquo;, since loading
          them tells the sender you opened their message. Mail from the senders
          below, or from everyone at a domain, shows them at once, except in
          Spam.
        </p>
        <add.Form key={round} className="flex flex-wrap items-end gap-2">
          <Field label="Sender" className="min-w-56 flex-1">
            <input
              name="sender"
              required
              maxLength={254}
              placeholder="name@example.com or example.com"
              className={inputClass}
            />
          </Field>
          <Button
            type="submit"
            name="intent"
            value="image-sender-add"
            loading={add.state === "submitting"}
          >
            Always load
          </Button>
        </add.Form>
        <Feedback result={add.data} error={add.error} />
      </div>
      {senders.length > 0 && (
        <ul className="divide-line border-line divide-y border-t">
          {senders.map((s) => (
            <ImageSenderRow key={s} sender={s} />
          ))}
        </ul>
      )}
    </Section>
  );
};

const Vacation = ({ vacation }: { vacation: MailSettingsData["vacation"] }) => {
  const act = useAction(mailSettingsAction);
  const [on, setOn] = useState(vacation.on);

  return (
    <Section title="Vacation responder">
      <act.Form className="space-y-3 p-4">
        <label className="text-fg flex items-center gap-2.5 text-base">
          <Checkbox
            name="on"
            checked={on}
            onChange={(e) => setOn(e.currentTarget.checked)}
          />
          Answer new mail automatically
        </label>
        <p className="text-muted -mt-1 pl-6 text-sm">
          Everyone who writes to you gets this reply once every four days,
          between the dates when they are set. Mail from lists, machines and
          no-reply addresses gets none.
        </p>
        <div className={cx("space-y-3", !on && "opacity-60")}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="First day" hint="Leave empty to start now.">
              <input
                type="date"
                name="from"
                defaultValue={vacation.from ?? ""}
                className={inputClass}
              />
            </Field>
            <Field
              label="Last day"
              hint="Leave empty to keep going until you switch it off."
            >
              <input
                type="date"
                name="until"
                defaultValue={vacation.until ?? ""}
                className={inputClass}
              />
            </Field>
          </div>
          <Field
            label="Subject"
            hint="Empty: “Automatic reply: Re: <their subject>”."
          >
            <input
              name="subject"
              defaultValue={vacation.subject}
              maxLength={200}
              className={inputClass}
            />
          </Field>
          <Field label="Message">
            <textarea
              name="text"
              defaultValue={vacation.text}
              rows={5}
              maxLength={5000}
              className={textareaClass}
            />
          </Field>
        </div>
        <Feedback result={act.data} error={act.error} />
        <Button
          type="submit"
          name="intent"
          value="vacation"
          variant="primary"
          loading={act.state === "submitting"}
        >
          Save
        </Button>
      </act.Form>
    </Section>
  );
};

/**
 * Settings → Mail: reading preferences, labels, filters, spam, the senders whose images always load, the vacation
 * responder and importing a mailbox.
 */
export const MailSettings = ({
  preferences,
  labels,
  filters,
  spam,
  imageSenders,
  vacation,
  imports,
  pgp,
  connect,
  reason,
}: MailSettingsData & { connect?: string; reason?: string }) => (
  <>
    <Preferences preferences={preferences} />
    <Labels labels={labels} />
    <Filters filters={filters} labels={labels} />
    <Spam spam={spam} />
    <Images senders={imageSenders} />
    <PgpSettings pgp={pgp} />
    <Vacation vacation={vacation} />
    <MailImport settings={imports} connect={connect} reason={reason} />
  </>
);
