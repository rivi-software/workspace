import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormHTMLAttributes } from "react";

type FormServerFn<R> = ((opts: { data: FormData }) => Promise<R>) & {
  url: string;
};

interface ActionContext<R> {
  submit: (input: FormData) => Promise<R | undefined>;
  fields: Record<string, string> | undefined;
}

const createForm = <R,>(ctx: { current: ActionContext<R> }, url: string) =>
  function ActionForm({
    onSubmit,
    children,
    ...props
  }: FormHTMLAttributes<HTMLFormElement>) {
    return (
      <form
        method="post"
        action={url}
        encType="multipart/form-data"
        {...props}
        onSubmit={(e) => {
          onSubmit?.(e);

          if (e.defaultPrevented) {
            return;
          }

          e.preventDefault();
          const form = e.currentTarget;
          const fd = new FormData(form);

          // SAFETY: nativeEvent on form onSubmit is SubmitEvent
          const submitEvent = e.nativeEvent as SubmitEvent;
          // SAFETY: submitter is an HTMLButtonElement or null
          const submitter = submitEvent.submitter as HTMLButtonElement | null;

          if (submitter?.name) {
            fd.set(submitter.name, submitter.value);
          }

          void ctx.current.submit(fd);
        }}
      >
        {Object.entries(ctx.current.fields ?? {}).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        {children}
      </form>
    );
  };

/**
 * Form submissions backed by a server function:
 *
 *   const act = useAction(threadAction, { id });
 *   <act.Form><Button name="intent" value="archive" type="submit">Archive</Button></act.Form>
 *
 * The submit button's name/value is included (so `intent` buttons work), `fields` are added as hidden
 * inputs, the server function receives the FormData, redirects thrown on the server navigate the
 * client, and every route loader on screen is revalidated afterwards. Without JavaScript the form
 * posts straight to the server function (see `formPost` in ./forms).
 */
export const useAction = <R,>(
  fn: FormServerFn<R>,
  fields?: Record<string, string>
) => {
  const router = useRouter();
  const call = useServerFn(fn);
  const [state, setState] = useState<"idle" | "submitting">("idle");
  const [data, setData] = useState<R | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const ctx = useRef<ActionContext<R>>({
    submit: () => Promise.resolve(undefined),
    fields,
  });

  const submit = useCallback(
    async (
      input: FormData | Record<string, string>
    ): Promise<R | undefined> => {
      let fd: FormData;

      if (input instanceof FormData) {
        fd = input;
      } else {
        fd = new FormData();

        for (const [k, v] of Object.entries(input)) {
          fd.set(k, v);
        }
      }

      for (const [k, v] of Object.entries(ctx.current.fields ?? {})) {
        fd.set(k, v);
      }

      setState("submitting");
      setError(null);

      try {
        // SAFETY: server function resolves with result of type R
        const result = (await call({ data: fd })) as R;
        setData(result);
        await router.invalidate();
        setState("idle");

        return result;
      } catch (callError) {
        setError(
          callError instanceof Error ? callError.message : String(callError)
        );
        setState("idle");
      }
    },
    [call, router, ctx]
  );

  useEffect(() => {
    ctx.current.fields = fields;
    ctx.current.submit = submit;
  }, [fields, submit, ctx]);

  const formComponent = useMemo(
    // oxlint-disable-next-line react/refs -- the ref is only handed to the form component, which reads it when it submits and when it renders its hidden fields; its identity never changes
    () => createForm(ctx, fn.url),
    [ctx, fn.url]
  );

  return {
    Form: formComponent,
    submit,
    data,
    state,
    error,
    clearError: () => setError(null),
  };
};
