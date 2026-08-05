import { type FormEvent, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ChatSession } from "@/types";

type SessionRenameDialogProps = {
  open: boolean;
  session: ChatSession | null;
  onOpenChange: (open: boolean) => void;
  onSave: (name: string) => void;
};

export function SessionRenameDialog({
  open,
  session,
  onOpenChange,
  onSave,
}: SessionRenameDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    setName(session?.title ?? "");
    setError(null);
    const animationFrame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [open, session?.title]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName) {
      setError("Enter a session name.");
      return;
    }

    onSave(nextName);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-5 p-5 sm:max-w-md">
        <form className="contents" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Rename session</DialogTitle>
            <DialogDescription>
              Choose a name that makes this session easy to find later.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <label className="sr-only" htmlFor="session-name">
              Session name
            </label>
            <Input
              ref={inputRef}
              id="session-name"
              className="h-10 px-3 text-base md:text-sm"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "session-name-error" : undefined}
            />
            {error ? (
              <p
                id="session-name-error"
                className="text-xs text-destructive"
                role="alert"
              >
                {error}
              </p>
            ) : null}
          </div>

          <DialogFooter className="-mx-0 -mb-0 border-0 bg-transparent p-0 sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
