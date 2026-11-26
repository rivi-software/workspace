import SwiftUI
import WorkspaceKit

/// A label's name on its soft fill, as the console's chips.
struct MailLabelChip: View {
  let label: LabelRef

  var body: some View {
    Text(label.name)
      .font(.caption2.weight(.medium))
      .lineLimit(1)
      .padding(.horizontal, 7)
      .padding(.vertical, 2)
      .foregroundStyle(Theme.label(label.color))
      .background(Theme.labelSoft(label.color), in: .capsule)
  }
}

/// A conversation in the list, as a mail app reads: the people first and strongest, then the
/// subject, then the snippet, with the first person's initials and, when unread, the lit dot.
struct MailThreadRow: View {
  let row: ListRow
  /// In Snoozed the time it comes back stands where the date would.
  let inSnoozed: Bool
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Circle()
        .fill(row.unread ? Theme.accent : Color.clear)
        .frame(width: 8, height: 8)
        .padding(.top, 16)
        .accessibilityHidden(true)
      // At the accessibility sizes the words need the width more than the disc does.
      if !typeSize.isAccessibilitySize {
        AvatarView(name: firstPerson, size: 40)
          .accessibilityHidden(true)
      }
      VStack(alignment: .leading, spacing: 2) {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(row.people)
            .font(.body.weight(row.unread ? .semibold : .regular))
            .lineLimit(1)
          if row.count > 1 {
            Text("\(row.count)")
              .font(.footnote.weight(.medium))
              .foregroundStyle(.secondary)
              .monospacedDigit()
          }
          Spacer(minLength: 8)
          marks
          time
        }
        Text(row.subject.isEmpty ? "(No subject)" : row.subject)
          .font(.subheadline.weight(row.unread ? .medium : .regular))
          .lineLimit(1)
        Text(row.snippet)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(2)
        if !row.labels.isEmpty {
          HStack(spacing: 4) {
            ForEach(row.labels) { MailLabelChip(label: $0) }
          }
          .padding(.top, 3)
        }
      }
    }
    .padding(.vertical, 2)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityWords)
  }

  /// "Ada Lovelace, Bob" gives "Ada Lovelace", whose initials the disc shows.
  private var firstPerson: String {
    let first = row.people.split(separator: ",").first.map(String.init) ?? row.people
    return first.trimmingCharacters(in: .whitespaces)
  }

  @ViewBuilder
  private var marks: some View {
    if row.muted {
      Image(systemName: "bell.slash")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
    if row.hasAttachments {
      Image(systemName: "paperclip")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
    if row.starred {
      Image(systemName: "star.fill")
        .font(.caption)
        .foregroundStyle(Theme.star)
    }
  }

  @ViewBuilder
  private var time: some View {
    if inSnoozed, let until = row.snoozedUntil {
      Text(MailSnooze.label(until))
        .font(.footnote)
        .foregroundStyle(Theme.amber)
    } else {
      RelativeDateText(date: row.lastMessageAt)
        .font(.footnote.weight(row.unread ? .medium : .regular))
        .foregroundStyle(row.unread ? Theme.accent : .secondary)
    }
  }

  private var accessibilityWords: String {
    var parts = [row.unread ? "Unread" : "Read", row.people, row.subject, row.snippet]
    if row.starred { parts.append("Starred") }
    if row.hasAttachments { parts.append("Has attachments") }
    if row.muted { parts.append("Muted") }
    parts.append(contentsOf: row.labels.map(\.name))
    return parts.filter { !$0.isEmpty }.joined(separator: ", ")
  }
}

/// A row of Drafts or Scheduled.
struct MailDraftRow: View {
  let draft: DraftRow

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text(draft.to.isEmpty ? "No recipient" : draft.to)
          .font(.subheadline)
          .foregroundStyle(draft.to.isEmpty ? .secondary : .primary)
          .lineLimit(1)
        Spacer(minLength: 8)
        if let scheduledAt = draft.scheduledAt {
          Label(MailSnooze.label(scheduledAt), systemImage: "clock")
            .font(.caption)
            .foregroundStyle(Theme.amber)
        } else {
          RelativeDateText(date: draft.updatedAt)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      Text(draft.subject.isEmpty ? "(No subject)" : draft.subject)
        .font(.body)
        .lineLimit(1)
      Text(draft.snippet)
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .lineLimit(2)
      if let error = draft.sendError {
        Label(error, systemImage: "exclamationmark.triangle.fill")
          .font(.caption)
          .foregroundStyle(Theme.red)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }
}
