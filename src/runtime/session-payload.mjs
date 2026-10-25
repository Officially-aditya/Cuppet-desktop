const INLINE_ATTACHMENT_LIMIT = 32 * 1024;

// Full attachment data stays in SQLite/provider history; desktop history loads it on demand.
export function projectSessionPayload(session) {
  return {
    ...session,
    messages: session.messages.map(message => ({
      ...message,
      attachments: message.attachments?.map(attachment => {
        if (!attachment.dataUrl || attachment.dataUrl.length <= INLINE_ATTACHMENT_LIMIT) return attachment;
        const { dataUrl, ...metadata } = attachment;
        return { ...metadata, hasData: true };
      }),
    })),
  };
}
