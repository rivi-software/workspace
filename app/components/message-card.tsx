import {
  Ban,
  ChevronDown,
  CircleCheck,
  Download,
  Forward,
  ImageIcon,
  MailMinus,
  Moon,
  MoreHorizontal,
  Paperclip,
  Printer,
  Reply,
  ReplyAll,
  Sun,
} from "lucide-react";
import { useMemo, useState } from "react";

import { displayName, formatAddress } from "~/lib/mail/addresses";
import type { MessageView } from "~/lib/mail/mailbox.server";
import { mailReading } from "~/lib/mail/sanitize";
import { describeSender } from "~/lib/mail/spam";
import type { Unsubscribe } from "~/lib/mail/unsubscribe";
import { formatBytes } from "~/lib/text";

import { HtmlMessage, TextMessage } from "./message-body";
import { useIsDark } from "./theme";
import {
  Avatar,
  Button,
  IconButton,
  Menu,
  MenuAnchor,
  MenuItem,
  MenuSeparator,
  Notice,
  Pill,
  Timestamp,
  cx,
} from "./ui";

/** What the thread page hands each card: the message, its markup made safe, and the files to list. */
export type MessageData = Omit<MessageView, "html" | "attachments"> & {
  html: string | null;
  remoteImages: boolean;
  /** Its images from the web load on opening: the owner always loads its sender's, and it is not in Spam. */
  loadImages: boolean;
  files: MessageView["attachments"];
  unsubscribe: Unsubscribe | null;
};

const IMAGE = /^image\/(?:png|jpeg|gif|webp|avif|bmp)$/u;

/** The owner's rule for a message's sender: blocked (their mail goes to Spam) or allowed (it never does). */
export interface SenderRuleView {
  sender: string;
  verdict: "block" | "allow";
}

type ComposeMode = "reply" | "all" | "forward";

interface MessageHeaderProps {
  message: MessageData;
  expanded: boolean;
  senderRule: SenderRuleView | null;
  onToggle: () => void;
  onCompose: (mode: ComposeMode, messageId: string) => void;
  onUnsubscribe: (message: MessageData) => void;
  onPrint: (messageId: string) => void;
  onBlock: (message: MessageData) => void;
  onUnblock: (sender: string) => void;
}

/** The line a folded message shows below the name: who it went to once open, its first words while folded. */
const preview = (m: MessageData, expanded: boolean) =>
  expanded
    ? `to ${m.to.map(displayName).join(", ") || "nobody"}`
    : m.text.replaceAll(/\s+/gu, " ").slice(0, 120);

/** Block or unblock the sender, by what the owner's rule says about them. */
const SenderItem = ({
  message: m,
  senderRule,
  onBlock,
  onUnblock,
}: Pick<
  MessageHeaderProps,
  "message" | "senderRule" | "onBlock" | "onUnblock"
>) => {
  if (senderRule?.verdict === "block") {
    return (
      <MenuItem
        icon={<CircleCheck className="h-3.5 w-3.5" />}
        onClick={() => onUnblock(senderRule.sender)}
      >
        Unblock {describeSender(senderRule.sender)}
      </MenuItem>
    );
  }

  return (
    <MenuItem icon={<Ban className="h-3.5 w-3.5" />} onClick={() => onBlock(m)}>
      Block {m.from.email}
    </MenuItem>
  );
};

/** The quick reply and the menu of what else this message can do. */
const MessageActions = ({
  message: m,
  senderRule,
  onCompose,
  onUnsubscribe,
  onPrint,
  onBlock,
  onUnblock,
}: Omit<MessageHeaderProps, "expanded" | "onToggle">) => (
  <span className="print-hidden flex shrink-0 items-center gap-0.5">
    <IconButton
      size="sm"
      label="Reply"
      onClick={() => onCompose("reply", m.id)}
    >
      <Reply className="h-3.5 w-3.5" />
    </IconButton>
    <Menu
      label="Message actions"
      renderTrigger={({ toggle, open }) => (
        <IconButton
          size="sm"
          label="More"
          onClick={toggle}
          active={open}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </IconButton>
      )}
    >
      <MenuItem
        icon={<Reply className="h-3.5 w-3.5" />}
        onClick={() => onCompose("reply", m.id)}
      >
        Reply
      </MenuItem>
      <MenuItem
        icon={<ReplyAll className="h-3.5 w-3.5" />}
        onClick={() => onCompose("all", m.id)}
      >
        Reply all
      </MenuItem>
      <MenuItem
        icon={<Forward className="h-3.5 w-3.5" />}
        onClick={() => onCompose("forward", m.id)}
      >
        Forward
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        icon={<Printer className="h-3.5 w-3.5" />}
        onClick={() => onPrint(m.id)}
      >
        Print
      </MenuItem>
      {m.hasRaw && (
        <MenuAnchor
          icon={<Download className="h-3.5 w-3.5" />}
          href={`/api/messages/${m.id}/raw`}
        >
          Download original
        </MenuAnchor>
      )}
      {(m.unsubscribe || m.direction === "inbound") && <MenuSeparator />}
      {m.unsubscribe && (
        <MenuItem
          icon={<MailMinus className="h-3.5 w-3.5" />}
          onClick={() => onUnsubscribe(m)}
        >
          Unsubscribe
        </MenuItem>
      )}
      {m.direction === "inbound" && (
        <SenderItem
          message={m}
          senderRule={senderRule}
          onBlock={onBlock}
          onUnblock={onUnblock}
        />
      )}
    </Menu>
  </span>
);

/** The header of a message: the button that folds and unfolds it, and its actions beside it. */
const MessageHeader = ({
  message: m,
  expanded,
  onToggle,
  ...actions
}: MessageHeaderProps) => {
  const from = displayName(m.from);

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <Avatar name={from} size={28} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-fg truncate text-base font-medium">
              {from}
            </span>
            {m.direction === "outbound" && <Pill tone="neutral">Sent</Pill>}
            {m.deliveryStatus === "failed" && (
              <Pill tone="red">Not delivered</Pill>
            )}
            {!m.read && !expanded && <Pill tone="accent">New</Pill>}
          </span>
          <span className="text-muted block truncate text-sm">
            {preview(m, expanded)}
          </span>
        </span>
        {m.files.length > 0 && (
          <Paperclip className="text-subtle h-3.5 w-3.5 shrink-0" />
        )}
        {/* The full moment where there is room; on a phone the time or the day, so the name keeps its room. */}
        <Timestamp
          iso={m.date}
          className="text-subtle shrink-0 text-sm sm:hidden"
        />
        <Timestamp
          iso={m.date}
          relative={false}
          className="text-subtle hidden shrink-0 text-sm sm:inline"
        />
      </button>
      <MessageActions message={m} {...actions} />
    </div>
  );
};

/** Every address of a message, shown under "Details". */
const MessageDetails = ({ message: m }: { message: MessageData }) => (
  <dl className="bg-sidebar mt-2 grid grid-cols-[56px_1fr] gap-x-2 gap-y-0.5 rounded-md px-3 py-2 text-sm">
    <dt className="text-subtle">From</dt>
    <dd className="text-fg break-all">{formatAddress(m.from)}</dd>
    <dt className="text-subtle">To</dt>
    <dd className="text-fg break-all">
      {m.to.map(formatAddress).join(", ") || "–"}
    </dd>
    {m.cc.length > 0 && (
      <>
        <dt className="text-subtle">Cc</dt>
        <dd className="text-fg break-all">
          {m.cc.map(formatAddress).join(", ")}
        </dd>
      </>
    )}
    {m.bcc.length > 0 && (
      <>
        <dt className="text-subtle">Bcc</dt>
        <dd className="text-fg break-all">
          {m.bcc.map(formatAddress).join(", ")}
        </dd>
      </>
    )}
    {m.replyTo && (
      <>
        <dt className="text-subtle">Reply to</dt>
        <dd className="text-fg break-all">{formatAddress(m.replyTo)}</dd>
      </>
    )}
    <dt className="text-subtle">Date</dt>
    <dd className="text-fg">
      <Timestamp iso={m.date} relative={false} />
    </dd>
    <dt className="text-subtle">Subject</dt>
    <dd className="text-fg">{m.subject}</dd>
  </dl>
);

/** "Details" and, where they apply, "Unsubscribe" and the light/dark switch, in the line above an open message. */
const MessageTools = ({
  message: m,
  details,
  onDetails,
  reading,
  swapped,
  onSwap,
  onUnsubscribe,
}: {
  message: MessageData;
  details: boolean;
  onDetails: () => void;
  /** The message's reading in the dark theme; null where there is none to switch. */
  reading: { dark: boolean } | null;
  swapped: boolean;
  onSwap: () => void;
  onUnsubscribe: (message: MessageData) => void;
}) => (
  <div className="flex flex-wrap items-center justify-between gap-2">
    <button
      type="button"
      onClick={onDetails}
      aria-expanded={details}
      className="hover:text-fg inline-flex items-center gap-1 rounded-sm"
    >
      {details ? "Hide details" : "Details"}
      <ChevronDown
        className={cx("h-3 w-3 transition-transform", details && "rotate-180")}
      />
    </button>
    <span className="flex items-center gap-3">
      {m.unsubscribe && m.direction === "inbound" && (
        <button
          type="button"
          onClick={() => onUnsubscribe(m)}
          className="hover:text-fg print-hidden inline-flex items-center gap-1 rounded-sm"
        >
          <MailMinus className="h-3 w-3" />
          Unsubscribe
        </button>
      )}
      {reading && (
        <button
          type="button"
          onClick={onSwap}
          aria-pressed={swapped}
          className="hover:text-fg print-hidden inline-flex items-center gap-1 rounded-sm"
        >
          {reading.dark ? (
            <Sun className="h-3 w-3" />
          ) : (
            <Moon className="h-3 w-3" />
          )}
          {reading.dark ? "Light background" : "Dark background"}
        </button>
      )}
    </span>
  </div>
);

/** The notice above a message whose images from the web wait for the reader. */
const RemoteImagesNotice = ({
  message: m,
  onLoad,
  onAlwaysImages,
}: {
  message: MessageData;
  onLoad: () => void;
  onAlwaysImages?: (message: MessageData) => void;
}) => (
  <div className="border-line bg-sidebar text-muted print-hidden mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-1.5 text-sm">
    <ImageIcon className="h-3.5 w-3.5" />
    <span className="flex-1">Images from the web are not shown.</span>
    <Button size="sm" onClick={onLoad}>
      Load images
    </Button>
    {onAlwaysImages && m.direction === "inbound" && (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          onLoad();
          onAlwaysImages(m);
        }}
      >
        <span className="max-w-64 truncate">Always from {m.from.email}</span>
      </Button>
    )}
  </div>
);

/** The images among a message's files, as thumbnails that open in a tab. */
const Pictures = ({ files }: { files: MessageData["files"] }) => (
  <ul className="mt-4 flex flex-wrap gap-2" aria-label="Images">
    {files.map((a) => (
      <li key={a.id}>
        <a
          href={a.url}
          target="_blank"
          rel="noopener noreferrer"
          title={`${a.filename} · ${formatBytes(a.size)}`}
          className="group/thumb border-line bg-bg hover:border-line-strong block overflow-hidden rounded-md border"
        >
          <img
            src={a.url}
            alt={a.filename}
            loading="lazy"
            className="block h-28 w-auto max-w-56 object-cover transition-opacity group-hover/thumb:opacity-90"
          />
          <span className="text-muted flex items-center gap-2 px-2 py-1 text-xs">
            <span className="max-w-44 truncate">{a.filename}</span>
            <span className="tnum text-subtle ml-auto">
              {formatBytes(a.size)}
            </span>
          </span>
        </a>
      </li>
    ))}
  </ul>
);

/** The files that are not images, each a chip that downloads. */
const Attachments = ({ files }: { files: MessageData["files"] }) => (
  <ul className="mt-4 flex flex-wrap gap-2" aria-label="Attachments">
    {files.map((a) => (
      <li key={a.id}>
        <a
          href={`${a.url}&download=1`}
          className="border-line bg-bg text-fg hover:border-line-strong hover:tint-hover inline-flex h-8 items-center gap-2 rounded-md border px-2.5 text-sm"
        >
          <Paperclip className="text-subtle h-3.5 w-3.5" />
          <span className="max-w-56 truncate">{a.filename}</span>
          <span className="tnum text-subtle">{formatBytes(a.size)}</span>
        </a>
      </li>
    ))}
  </ul>
);

/**
 * One message in a conversation: the header folds and unfolds it, the details show every address, the HTML part
 * sits in its frame, the files line up below, with the images among them as thumbnails. Its menu replies to or
 * forwards this message, not the last one, prints or downloads it, and blocks or unblocks its sender. Images from
 * the web wait for "Load images", or for nothing when the owner always loads the sender's.
 */
export const MessageCard = ({
  message: m,
  origin,
  expanded,
  onAlwaysImages,
  onUnsubscribe,
  ...handlers
}: Omit<MessageHeaderProps, "message"> & {
  message: MessageData;
  origin: string;
  /** Always load the images of its sender's mail; absent where that is not offered (Spam). */
  onAlwaysImages?: (message: MessageData) => void;
}) => {
  const [details, setDetails] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const images = loaded || m.loadImages;
  // The reader's switch between a light and a dark reading of this message, in the dark theme.
  const [swapped, setSwapped] = useState(false);
  const dark = useIsDark();

  const reading = useMemo(
    () =>
      m.html && dark !== null ? mailReading(m.html, { dark, swapped }) : null,
    [m.html, dark, swapped]
  );

  const pictures = m.files.filter((a) => IMAGE.test(a.contentType));
  const others = m.files.filter((a) => !IMAGE.test(a.contentType));

  return (
    <li
      data-message={m.id}
      className="border-line bg-elevated animate-rise-in rounded-lg border print:break-inside-avoid print:border-0"
    >
      <MessageHeader
        message={m}
        expanded={expanded}
        onUnsubscribe={onUnsubscribe}
        {...handlers}
      />
      {expanded && (
        <div className="border-line border-t px-4 pt-3 pb-4">
          <div className="text-muted mb-3 text-sm">
            <MessageTools
              message={m}
              details={details}
              onDetails={() => setDetails((d) => !d)}
              reading={dark ? reading : null}
              swapped={swapped}
              onSwap={() => setSwapped((s) => !s)}
              onUnsubscribe={onUnsubscribe}
            />
            {details && <MessageDetails message={m} />}
          </div>
          {m.deliveryError && (
            <Notice tone="error" className="mb-3">
              {m.deliveryError}
            </Notice>
          )}
          {m.html && m.remoteImages && !images && (
            <RemoteImagesNotice
              message={m}
              onLoad={() => setLoaded(true)}
              onAlwaysImages={onAlwaysImages}
            />
          )}
          {m.html ? (
            <HtmlMessage
              html={m.html}
              origin={origin}
              loadImages={images}
              reading={reading}
            />
          ) : (
            <TextMessage text={m.text} />
          )}
          {pictures.length > 0 && <Pictures files={pictures} />}
          {others.length > 0 && <Attachments files={others} />}
        </div>
      )}
    </li>
  );
};
