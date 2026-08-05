import { Folder, FolderPlus, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

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
import type { Project } from "@/types";

type ProjectDialogProps = {
  open: boolean;
  project: Project | null;
  onOpenChange: (open: boolean) => void;
  onSave: (name: string, sourceFolder: string) => void;
};

function folderName(sourceFolder: string) {
  return sourceFolder.split(/[\\/]/).filter(Boolean).at(-1) ?? "Source folder";
}

export function ProjectDialog({
  open,
  project,
  onOpenChange,
  onSave,
}: ProjectDialogProps) {
  const [name, setName] = useState("");
  const [sourceFolder, setSourceFolder] = useState("");
  const [error, setError] = useState<string | null>(null);
  const isEditing = project !== null;

  useEffect(() => {
    if (open) {
      setName(project?.name ?? "");
      setSourceFolder(project?.sourceFolder ?? "");
      setError(null);
    }
  }, [open, project?.name, project?.sourceFolder]);

  async function chooseFolder() {
    const folder = await window.electron.selectSourceFolder();
    if (!folder) {
      return;
    }

    setSourceFolder(folder);
    setError(null);
    if (!name.trim()) {
      setName(folderName(folder));
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Enter a project name.");
      return;
    }
    if (!sourceFolder.trim()) {
      setError("Add the folder the agent should work in.");
      return;
    }

    onSave(name.trim(), sourceFolder.trim());
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-6 p-6 sm:max-w-xl">
        <form className="contents" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle className="text-2xl leading-tight font-semibold tracking-[-0.025em]">
              {isEditing ? "Edit project" : "Add project"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {isEditing
                ? "Change the project name or its source folder."
                : "Name the project and choose its source folder."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-6">
            <label className="grid gap-2" htmlFor="project-name">
              <span className="text-sm font-medium text-foreground">
                Project name
              </span>
              <Input
                id="project-name"
                className="h-11 rounded-xl px-3.5 text-base md:text-base"
                autoFocus
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setError(null);
                }}
                placeholder="Project name"
              />
            </label>

            <div className="grid gap-2">
              <p className="text-sm font-medium text-foreground">
                Source folder
              </p>
              <div className="overflow-hidden rounded-xl border border-border bg-background/35">
                {sourceFolder ? (
                  <div className="flex min-h-14 items-center gap-3 px-3.5">
                    <Folder
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span
                      className="min-w-0 flex-1 truncate text-sm"
                      title={sourceFolder}
                    >
                      {folderName(sourceFolder)}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={`Remove ${folderName(sourceFolder)}`}
                      onClick={() => {
                        setSourceFolder("");
                        setError(null);
                      }}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="flex min-h-14 w-full items-center gap-3 px-3.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    onClick={() => void chooseFolder()}
                  >
                    <FolderPlus className="size-4" aria-hidden="true" />
                    <span>Add folder</span>
                  </button>
                )}
              </div>
              {sourceFolder ? (
                <button
                  type="button"
                  className="w-fit text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  onClick={() => void chooseFolder()}
                >
                  Choose a different folder
                </button>
              ) : null}
            </div>

            {error ? (
              <p className="text-xs text-destructive" role="alert">
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
            <Button type="submit">{isEditing ? "Save" : "Add project"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type RemoveProjectDialogProps = {
  open: boolean;
  project: Project | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
};

export function RemoveProjectDialog({
  open,
  project,
  onOpenChange,
  onConfirm,
}: RemoveProjectDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove {project?.name ?? "project"}?</DialogTitle>
          <DialogDescription>
            This removes the project and its chats from Conductor. Its source
            folder and agent conversations stay on disk.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            Remove project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
