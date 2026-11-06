import { AbstractChat } from "ai";
import type { ChatInit, ChatState, ChatStatus, UIMessage } from "ai";
import { useState, useSyncExternalStore } from "react";

/**
 * The AI SDK's chat for React, in the few lines `@ai-sdk/react` spends on it: the SDK's `AbstractChat` drives the
 * request, the stream and the status; this state tells React when any of it changed. (The React package pins
 * another `ai` and would put a second copy of the SDK in the bundle.)
 */
const snapshot = <T>(thing: T): T => structuredClone(thing);

interface ChatStore<M extends UIMessage> extends ChatState<M> {
  subscribe: (listener: () => void) => () => void;
}

const createChatStore = <M extends UIMessage>(
  initialMessages: M[]
): ChatStore<M> => {
  let messages = initialMessages;
  let status: ChatStatus = "ready";
  let error: Error | undefined;
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const l of listeners) {
      l();
    }
  };

  return {
    get status() {
      return status;
    },
    set status(value: ChatStatus) {
      status = value;
      emit();
    },
    get error() {
      return error;
    },
    set error(value: Error | undefined) {
      error = value;
      emit();
    },
    get messages() {
      return messages;
    },
    set messages(value: M[]) {
      messages = value;
      emit();
    },
    pushMessage(message: M) {
      messages = [...messages, message];
      emit();
    },
    popMessage() {
      messages = messages.slice(0, -1);
      emit();
    },
    replaceMessage(index: number, message: M) {
      const next = [...messages];
      next[index] = snapshot(message);
      messages = next;
      emit();
    },
    snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
};

class ReactChat<M extends UIMessage> extends AbstractChat<M> {
  readonly store: ChatStore<M>;
  constructor(init: ChatInit<M>) {
    const store = createChatStore<M>(init.messages ?? []);
    super({ ...init, state: store });
    this.store = store;
  }
}

/** A chat on the given transport, kept for the component's life; `messages` are its start. */
export const useChat = <M extends UIMessage>(init: ChatInit<M>) => {
  const [chat, setChat] = useState(() => new ReactChat<M>(init));
  void setChat;
  const { store } = chat;

  const messages = useSyncExternalStore(
    store.subscribe,
    () => store.messages,
    () => store.messages
  );

  const status = useSyncExternalStore(
    store.subscribe,
    () => store.status,
    () => store.status
  );

  const error = useSyncExternalStore(
    store.subscribe,
    () => store.error,
    () => store.error
  );

  return {
    messages,
    status,
    error,
    sendMessage: chat.sendMessage,
    regenerate: chat.regenerate,
    stop: chat.stop,
    clearError: chat.clearError,
  };
};
