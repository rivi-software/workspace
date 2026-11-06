# Workspace

A workspace on Cloudflare: every person's Mail, Drive, Calendar and Tasks, and an Assistant over their mail and files.

## Language

### People

**Person**:
Someone with a mailbox in the workspace.
_Avoid_: user, account, member (a role)

**Admin**:
A person who may also create mailboxes and manage the other people: their passwords, passkeys, second factor, aliases, roles and sessions.

### Mail

**Mailbox**:
A person's mail: everything sent to their primary address on the mail domain or to one of their aliases.
_Avoid_: inbox (one folder of it), account

**Alias**:
An extra address delivered to a mailbox, which its owner may also send from.

**Thread**:
The messages of one exchange in one mailbox, shown together.
_Avoid_: conversation (the Assistant's word)

**Folder**:
Where a thread sits: the inbox, the archive, Spam or the trash. A thread is in exactly one.
_Avoid_: label, view

**Label**:
A person's own tag on a thread; a thread may carry any number.
_Avoid_: tag, category, folder

**View**:
What a mail list shows: a folder, the threads with a mark (starred, snoozed, sent), a label, or All mail.
_Avoid_: filter (a rule), folder (only one kind of view)

**Thread state**:
Where a thread sits and how it is marked: its folder, star, mute, snooze, labels and counts.

**Intent**:
One thing a person does to threads from a list or a thread: archive, trash, report spam, star, snooze, label, mark read, mute.
_Avoid_: command, operation

**Undo record**:
What an intent changed, kept so Undo puts exactly that back, without doing the intent's checks or its learning again.
_Avoid_: undo steps, reverse action

**Filing**:
Putting one message into one mailbox, once per Message-ID: into its thread, with its raw copy and its files.
_Avoid_: ingesting, storing, saving

**Filing policy**:
Why a message is filed, which decides what it does to a thread that exists: arrival (mail that arrives), history (an import), or sent (the owner's copy of what they sent).

**Placement**:
Where a filed message puts its thread and how it marks it and itself, decided before filing by the filters and the spam filter, or by the source of an import.

**Own copy**:
A message the owner sent to one of their own addresses, which comes back through Email Routing: one message, in the inbox and under Sent.

**Filter**:
A person's rule that acts on mail as it arrives: skip the inbox, mark read, star, label, trash, send to Spam or keep out of it.
_Avoid_: rule (in prose it is fine; the setting is Filters)

**Spam filter**:
What decides on arrival whether mail goes to Spam, from the person's sender rules, the points mail scores and what it learnt from Report spam and Not spam.

**Import**:
A mailbox's history copied in from another provider; it is filed, never delivered, so no filter, vacation reply or notification runs for it.

**Scheduled message**:
A draft set to go out by itself at a moment the person chose.

### Drive

**Node**:
A folder or a file in Drive.
_Avoid_: item, entry, document

**Share**:
A node its owner gave to a colleague or to everyone, as viewer or editor; a share on a folder covers everything under it.

**Role**:
What a person may do with a node: owner, editor or viewer, the strongest that a share on the node or a folder above it gives.

**Reach**:
A person reaches a node they own or that is shared with them, unless the trash hides it. Nothing in Drive is listed, opened or changed for a person who does not reach it.
_Avoid_: access, visibility, permission

**Trash policy**:
Which part of the trash a look at Drive includes: none of it, the person's own trashed nodes as well, or only those (the Trash view).

**Link**:
A node shared outside the workspace: a link anyone holding it opens (after its password, when it has one), or an invite for one address, confirmed with a mailed code. Viewer only, for as long as its maker still reaches the node.
_Avoid_: public share, external share

**Signing request**:
A PDF sent to a customer to sign, with the fields placed on it for the customer and for the workspace's side; the customer signs first, then the inside signer.
_Avoid_: envelope, contract (the document is any PDF)

**Inside signer**:
The person in the workspace who signs a signing request for its organisation: whoever asked, or a colleague they chose.

**Auto-signing**:
The inside signature given at once with the asker's saved signature, as soon as the customer has signed, because the asker chose it when sending.

**Hand signature**:
A person's own signature, drawn or typed, saved to sign with.
_Avoid_: mail signature (the text under a message)

**Signed copy**:
The PDF with every field filled in and both signatures drawn in, and a certificate page after the last, kept with the request and filed in Drive.

### Calendar and Tasks

**Event**:
Something on a person's calendar at a time or on whole days, theirs to change, which colleagues can be invited to.
_Avoid_: appointment, meeting (one kind of event), booking

**Occurrence**:
One time a repeated event happens; the calendar lists occurrences, the event is what is kept.
_Avoid_: instance

**Attendee**:
A colleague invited to an event, who sees it on their own calendar and accepts or declines.
_Avoid_: guest, participant (Mail's word for someone on a thread)

**Task**:
A person's own to-do, due on a day or not, open until done.
_Avoid_: todo, item, issue (GitHub's)

**Due day**:
The day a task is due, a date without a time, in whatever zone the person reads it.
_Avoid_: deadline, due date

**Linked issue**:
The GitHub issue a task was made from or linked to; marking the task done closes it.

**GitHub connection**:
A person's own GitHub token, kept sealed, which their Tasks read assigned issues with and close an issue through.
_Avoid_: integration

### Identity

**Session**:
A person signed in on one browser or client, until they sign out, it expires (14 days) or a revocation ends it. Kept in the database and read on every request.

**Revocation**:
Ending what a person's old credentials allowed: their sessions, and the reset links already mailed to their recovery addresses. "Sign out everywhere" ends every session; a new password from an admin or a reset link, and a deactivation, end every session and every reset link; the person's own new password ends every reset link and every other session; removing a confirmed recovery address ends every reset link.
_Avoid_: logout (one session)

**Passkey**:
A credential a person keeps on a device (Touch ID, Windows Hello, a phone, a security key) that signs them in without a password, bound to the workspace's address. A person may have several; an admin can remove them all for someone who lost the device.
_Avoid_: WebAuthn credential, biometric login

**Second factor**:
What a password sign-in asks for after the password when the person set it up: the code of an authenticator app. A browser the person trusted skips it for 30 days. An admin can reset it for someone who lost their phone.
_Avoid_: 2FA, MFA, two-step

**Backup code**:
One of the codes shown once when the authenticator app was set up, each good for one sign-in in place of the app's code.
_Avoid_: recovery code (a recovery address resets a password)

**Recovery address**:
A personal address outside the mail domain, confirmed from a link mailed to it, where a person can be sent a link to reset a forgotten password. Three at most.
_Avoid_: backup email, secondary email

**One-time password**:
The password an admin hands a person with a new mailbox, or after a reset: shown once, meant to be changed at the first sign-in. The first admin's comes from `pnpm run admin:create`.
_Avoid_: temporary password, initial password

### Assistant

**Assistant**:
The workspace's AI, which answers a person's questions over their own mail and files and may prepare a draft, never send one.
_Avoid_: bot, agent

**Assistant conversation**:
One chat with the Assistant, kept with its messages until the person deletes it.
_Avoid_: thread, chat session
