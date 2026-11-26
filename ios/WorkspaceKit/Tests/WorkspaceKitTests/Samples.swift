import Foundation

/// Sample answers as API.md shapes them.
enum Samples {
  static let me = """
    {"user":{"id":"u_1","name":"Ada Lovelace","email":"ada@rivi.software","role":"admin"},
     "appName":"RIVI Workspace",
     "counts":{"inboxUnread":3,"spamUnread":1,"snoozed":0,"drafts":2,"scheduled":0,"labels":{"lb_1":2}},
     "labels":[{"id":"lb_1","name":"Finance","color":"teal"},{"id":"lb_2","name":"New","color":"magenta"}],
     "mailboxes":[{"id":"usr_help","name":"Help desk","email":"help@rivi.software",
       "counts":{"inboxUnread":4,"spamUnread":0,"snoozed":0,"drafts":0,"scheduled":0,"labels":{}},"labels":[]}],
     "preferences":{"layout":"split","undoSendSeconds":10,"pageSize":50},
     "driveUsed":123456789,"github":{"connected":true},
     "colleagues":[{"id":"u_2","name":"Bob","email":"bob@rivi.software"}],
     "assistant":{"enabled":true},
     "suggestions":["What did Bob send this week?"]}
    """

  static let threadList = """
    {"folder":"inbox","q":"","page":1,"pageSize":25,"total":1,"label":null,
     "threads":[{"id":"th_1","subject":"Invoice 42","snippet":"Please find","people":"Bob, me","count":2,
       "unread":true,"starred":false,"hasAttachments":true,"muted":false,"sent":true,
       "lastMessageAt":"2026-11-06T09:30:00.000Z","snoozedUntil":null,"folder":"inbox",
       "labels":[{"id":"lb_1","name":"Finance","color":"teal"}]}],
     "drafts":[]}
    """

  static let threadDetail = """
    {"thread":{"id":"th_1","subject":"Invoice 42","folder":"outbox","starred":false,"muted":false,"snoozedUntil":null,
       "messageCount":1,"unreadCount":0,"lastMessageAt":"2026-11-06T09:30:00Z",
       "participants":[{"email":"bob@acme.com","name":"Bob"},{"email":"ada@rivi.software","name":null}]},
     "labels":[],
     "messages":[{"id":"m_1","direction":"inbound","from":{"email":"bob@acme.com","name":"Bob"},
       "to":[{"email":"ada@rivi.software","name":"Ada"}],"cc":[],"bcc":[],"replyTo":null,
       "subject":"Invoice 42","text":"Please find the invoice attached.","hasHtml":true,"remoteImages":false,
       "date":"2026-11-06T09:30:00.000Z","read":true,"deliveryStatus":"received","deliveryError":null,"spam":false,
       "attachments":[{"id":"at_1","filename":"invoice.pdf","contentType":"application/pdf","size":12345,
         "inline":false,"contentId":null,"url":"/api/files/at_1?sig=abc"}]}]}
    """

  static let drive = """
    {"view":"mine","q":"","folder":null,"crumbs":[],
     "rows":[{"id":"dn_1","kind":"folder","name":"Contracts","contentType":"","size":0,
       "updatedAt":"2026-11-01T10:00:00.000Z","createdAt":"2026-10-01T10:00:00.000Z","trashedAt":null,
       "starred":true,"shared":false,"linked":false,"role":"owner","owner":{"id":"u_1","name":"Ada"},"parentId":null},
      {"id":"dn_2","kind":"file","name":"plan.pdf","contentType":"application/pdf","size":4096,
       "updatedAt":"2026-11-02T10:00:00.000Z","createdAt":"2026-11-02T10:00:00.000Z","trashedAt":null,
       "starred":false,"shared":true,"linked":true,"role":"editor","owner":{"id":"u_2","name":"Bob"},"parentId":"dn_1"}],
     "canWrite":true,"used":4096}
    """

  static let node = """
    {"node":{"id":"dn_2","kind":"file","name":"plan.pdf","contentType":"application/pdf","size":4096,
       "updatedAt":"2026-11-02T10:00:00.000Z","createdAt":"2026-11-02T10:00:00.000Z","trashedAt":null,
       "starred":false,"shared":true,"linked":true,"role":"editor","owner":{"id":"u_2","name":"Bob"},"parentId":"dn_1"},
     "crumbs":[{"id":"dn_1","name":"Contracts"}],"preview":"pdf",
     "shares":[{"person":null,"role":"viewer"},{"person":{"id":"u_1","name":"Ada"},"role":"editor"}]}
    """

  static let calendar = """
    {"from":"2026-11-02","to":"2026-11-10",
     "events":[{"id":"ev_1","owner":{"id":"u_1","name":"Ada"},"mine":true,"title":"Standup","description":"","location":"",
       "startsAt":"2026-11-03T09:00:00.000Z","endsAt":"2026-11-03T09:15:00.000Z","allDay":false,"timeZone":"Europe/Amsterdam",
       "repeat":"weekly","repeatUntil":null,"attendees":[{"id":"u_2","name":"Bob","status":"accepted"}],
       "myStatus":null,"updatedAt":"2026-11-01T08:00:00.000Z",
       "key":"ev_1:2026-11-03","start":"2026-11-03T09:00:00.000Z","end":"2026-11-03T09:15:00.000Z"}],
     "tasks":[],"colleagues":[{"id":"u_2","name":"Bob","email":"bob@rivi.software"}]}
    """

  static let tasks = """
    {"view":"open",
     "tasks":[{"id":"tk_1","title":"Ship the app","notes":"","status":"open","priority":"high","dueOn":"2026-11-07",
       "completedAt":null,"github":null,
       "updatedAt":"2026-11-06T08:00:00.000Z","createdAt":"2026-11-05T08:00:00.000Z"},
      {"id":"tk_2","title":"Fix the sign-in","notes":"","status":"open","priority":"normal","dueOn":null,
       "completedAt":null,
       "github":{"repo":"acme/app","number":12,"url":"https://github.com/acme/app/issues/12","title":"Fix the sign-in",
         "state":"open","syncedAt":"2026-11-06T07:00:00.000Z"},
       "updatedAt":"2026-11-06T08:00:00.000Z","createdAt":"2026-11-05T08:00:00.000Z"}],
     "github":{"connected":true,"issues":[{"repo":"acme/app","number":14,"title":"Cannot sign in",
       "url":"https://github.com/acme/app/issues/14","state":"open","updatedAt":"2026-11-06T06:00:00Z","labels":["bug"]}]}}
    """

  static let conversation = """
    {"conversation":{"id":"ac_1","title":"Invoices","updatedAt":"2026-11-06T09:00:00.000Z"},
     "messages":[{"id":"am_1","role":"user","parts":[{"type":"text","text":"Find the invoice"}]},
       {"id":"am_2","role":"assistant","parts":[{"type":"step-start"},
         {"type":"tool-search_mail","toolCallId":"call_1","state":"output-available","input":{"query":"invoice"},"output":{"count":3}},
         {"type":"text","text":"Three conversations mention an invoice."},
         {"type":"reasoning","text":"hidden"}]}]}
    """

  static let compose = """
    {"froms":[{"email":"ada@rivi.software","name":"Ada Lovelace"}],
     "signatures":[{"id":"sg_1","name":"Work","text":"Ada","html":null}],
     "prefill":{"draftId":null,"threadId":"th_1","inReplyToId":"m_1","mode":"reply","from":"ada@rivi.software",
       "to":"Bob <bob@acme.com>","cc":"","bcc":"","subject":"Re: Invoice 42","text":"","html":"","signatureId":"sg_1","files":[]},
     "undoSendSeconds":10}
    """

  static let chatStream = """
    data: {"type":"start","messageId":"am_9","messageMetadata":{"conversationId":"ac_7"}}

    data: {"type":"start-step"}

    data: {"type":"tool-input-start","toolCallId":"call_1","toolName":"search_mail"}

    data: {"type":"tool-input-available","toolCallId":"call_1","toolName":"search_mail","input":{"query":"invoice"}}

    data: {"type":"tool-output-available","toolCallId":"call_1","output":{"count":3}}

    data: {"type":"finish-step"}

    data: {"type":"start-step"}

    data: {"type":"text-start","id":"t1"}

    data: {"type":"text-delta","id":"t1","delta":"Three conversations "}

    data: {"type":"text-delta","id":"t1","delta":"mention an invoice."}

    data: {"type":"text-end","id":"t1"}

    data: {"type":"finish-step"}

    data: {"type":"finish"}

    data: [DONE]

    """
}
