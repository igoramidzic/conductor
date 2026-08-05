import { FolderOpen } from "lucide-react";
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

type ProjectDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string, sourceFolder: string) => void;
};

export function ProjectDialog({
  open,
  onOpenChange,
  onCreate,
}: ProjectDialogProps) {
  const [name, setName] = useState("");
  const [sourceFolder, setSourceFolder] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setSourceFolder("");
      setError(null);
    }
  }, [open]);

  async function chooseFolder() {
    const folder = await window.electron.selectSourceFolder();
    if (!folder) {
      return;
    }

    setSourceFolder(folder);
    setError(null);
    if (!name.trim()) {
      setName(folder.split(/[\\/]/).filter(Boolean).at(-1) ?? "New project");
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Enter a project name.");
      return;
    }
    if (!sourceFolder.trim()) {
      setError("Choose the folder the agent should work in.");
      return;
    }

    onCreate(name.trim(), sourceFolder.trim());
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form className="contents" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Add project</DialogTitle>
            <DialogDescription>
              Give this workspace a name and choose the source folder the agent
              can work in.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-1">
            <label className="grid gap-1.5" htmlFor="project-name">
              <span className="text-xs font-medium text-foreground">
                Project name
              </span>
              <Input
                id="project-name"
                autoFocus
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setError(null);
                }}
                placeholder="Website redesign"
              />
            </label>

            <label className="grid gap-1.5" htmlFor="project-folder">
              <span className="text-xs font-medium text-foreground">
                Source folder
              </span>
              <div className="flex gap-2">
                <Input
                  id="project-folder"
                  className="font-mono text-xs"
                  value={sourceFolder}
                  onChange={(event) => {
                    setSourceFolder(event.target.value);
                    setError(null);
                  }}
                  placeholder="/Users/you/code/project"
                />
                <Button type="button" variant="outline" onClick={chooseFolder}>
                  <FolderOpen aria-hidden="true" />
                  Browse
                </Button>
              </div>
            </label>

            {error ? (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit">Add project</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
