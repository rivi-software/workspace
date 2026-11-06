-- Demo data for local development (MAIL_DOMAIN=example.com in .dev.vars). Password for every account is "password".
-- The hash is rendered by scripts/build-seed.mjs with app/lib/auth.server.ts's PBKDF2-SHA256, 100k iterations, into
-- each person's `credential` account, where Better Auth reads it.
INSERT OR IGNORE INTO users (id, email, name, role, updated_at) VALUES
 ('usr_admin', 'admin@example.com', 'Alex Admin', 'admin', __NOW_MS__),
 ('usr_sam', 'sam@example.com', 'Sam Member', 'member', __NOW_MS__);

INSERT OR IGNORE INTO accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES
 ('acc_admin', 'usr_admin', 'credential', 'usr_admin', '__PASSWORD_HASH__', __NOW_MS__, __NOW_MS__),
 ('acc_sam', 'usr_sam', 'credential', 'usr_sam', '__PASSWORD_HASH__', __NOW_MS__, __NOW_MS__);

-- Two signatures for the admin, so the composer's selector has a choice: new messages start on the first, replies
-- and forwards on the second.
INSERT OR IGNORE INTO signatures (id, user_id, name, text, is_default, is_reply_default, created_at) VALUES
 ('sig_admin_work', 'usr_admin', 'Work', 'Alex Admin
Example Inc.', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute')),
 ('sig_admin_short', 'usr_admin', 'Short', '— Alex', 0, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR IGNORE INTO aliases (address, user_id) VALUES ('hello@example.com', 'usr_admin');

-- A first conversation in the admin's inbox, so the list is not empty before the first `pnpm run email:simulate`.
INSERT OR IGNORE INTO threads (id, user_id, subject, snippet, folder, message_count, unread_count, participants_json, last_message_at) VALUES
 ('th_welcome', 'usr_admin', 'Welcome to Workspace', 'Your mailbox is ready. Mail sent to admin@example.com lands here…', 'inbox', 1, 1,
  '[{"email":"workspace@example.com","name":"Workspace"}]', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT OR IGNORE INTO messages (id, thread_id, user_id, direction, message_id, from_email, from_name, to_json, subject, text, snippet, date, read, size, delivery_status) VALUES
 ('msg_welcome', 'th_welcome', 'usr_admin', 'inbound', '<welcome@example.com>', 'workspace@example.com', 'Workspace',
  '[{"email":"admin@example.com","name":"Alex Admin"}]', 'Welcome to Workspace',
  'Your mailbox is ready. Mail sent to admin@example.com lands here; hello@example.com reaches it too.

Press c to write a message, / to search, and ? for the list of shortcuts.',
  'Your mailbox is ready. Mail sent to admin@example.com lands here…', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0, 300, 'received');
