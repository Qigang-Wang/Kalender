import * as React from 'react';

import { toast } from 'sonner';
import { z } from 'zod';

export interface UploadedFile {
  readonly key: string;
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly url: string;
}

interface UseUploadFileProps {
  onUploadComplete?: (file: UploadedFile) => void;
  onUploadError?: (error: unknown) => void;
}

export function useUploadFile({
  onUploadComplete,
  onUploadError,
}: UseUploadFileProps = {}) {
  const [uploadedFile, setUploadedFile] = React.useState<UploadedFile>();
  const [uploadingFile, setUploadingFile] = React.useState<File>();
  const [progress, setProgress] = React.useState<number>(0);
  const [isUploading, setIsUploading] = React.useState(false);

  async function uploadThing(file: File) {
    setIsUploading(true);
    setUploadingFile(file);

    try {
      setProgress(15);
      const formData = new FormData();
      formData.set('file', file);
      const response = await fetch('/api/editor-assets', {
        method: 'POST',
        body: formData,
      });
      const payload = await response.json().catch(() => null) as {
        readonly file?: UploadedFile;
        readonly message?: string;
      } | null;
      if (!response.ok || !payload?.file) {
        throw new Error(payload?.message ?? "Datei-Upload fehlgeschlagen");
      }
      setProgress(100);
      setUploadedFile(payload.file);
      onUploadComplete?.(payload.file);
      return payload.file;
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      const message =
        errorMessage.length > 0
          ? errorMessage
          : 'Something went wrong, please try again later.';

      toast.error(message);

      onUploadError?.(error);
      throw error;
    } finally {
      setProgress(0);
      setIsUploading(false);
      setUploadingFile(undefined);
    }
  }

  return {
    isUploading,
    progress,
    uploadedFile,
    uploadFile: uploadThing,
    uploadingFile,
  };
}

export function getErrorMessage(err: unknown) {
  const unknownError = 'Something went wrong, please try again later.';

  if (err instanceof z.ZodError) {
    const errors = err.issues.map((issue) => issue.message);

    return errors.join('\n');
  }
  if (err instanceof Error) {
    return err.message;
  }
  return unknownError;
}

export function showErrorToast(err: unknown) {
  const errorMessage = getErrorMessage(err);

  return toast.error(errorMessage);
}
