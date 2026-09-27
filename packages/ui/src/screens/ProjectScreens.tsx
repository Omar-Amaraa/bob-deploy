import { projectCreateInputSchema, type ProjectCreateInput } from '@bob-deploy/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { FolderOpen } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Field } from '../components/ui.js';
import { useIpc } from '../ipc/context.js';

export function AddProjectScreen() {
  const ipc = useIpc();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    clearErrors,
    setError,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ProjectCreateInput>({
    resolver: zodResolver(projectCreateInputSchema),
    defaultValues: { folderPath: '', name: '' },
  });
  const folderPath = watch('folderPath');

  async function chooseFolder() {
    clearErrors('folderPath');
    clearErrors('root');
    if (!window.bobDeploy) {
      setError('root', { message: 'Open this screen in the Bob Deploy desktop app to choose a folder.' });
      return;
    }
    try {
      const path = await window.bobDeploy.pickFolder();
      if (!path) return;
      setValue('folderPath', path, { shouldDirty: true, shouldValidate: true });
      setValue('name', path.split(/[\\/]/).filter(Boolean).at(-1) ?? '', {
        shouldDirty: true,
        shouldValidate: true,
      });
    } catch {
      setError('root', { message: 'The folder chooser could not open. Close it and try again.' });
    }
  }

  const submit = handleSubmit(async (values) => {
    const result = await ipc['projects:create'](values);
    if (!result.ok) {
      if (result.error.code === 'CONFLICT') {
        setError('folderPath', { message: 'That folder is already a project.' });
      } else if (result.error.code === 'VALIDATION' && result.error.message.startsWith('name')) {
        setError('name', { message: result.error.message.replace(/^name:\s*/, '') });
      } else {
        setError('root', { message: result.error.message });
      }
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ['projects'] });
    const bob = await ipc['bob:status']();
    const deployPath = `/p/${result.data.id}/deploy`;
    if (!bob.ok) {
      setError('root', { message: bob.error.message });
      return;
    }
    if (!bob.data.configured) {
      void navigate(`/settings/bob?returnTo=${encodeURIComponent(deployPath)}`, { replace: true });
      return;
    }
    void navigate(deployPath, { replace: true });
  });

  return (
    <Card className="project-form">
      <p className="eyebrow">New project</p>
      <h1>Add a project</h1>
      <p>Choose the folder that contains your site.</p>
      <Button type="button" className="button-secondary" onClick={() => void chooseFolder()}>
        <FolderOpen aria-hidden="true" />
        Choose your project folder
      </Button>
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
        noValidate
      >
        <input type="hidden" {...register('folderPath')} />
        {folderPath ? <p className="selected-path">{folderPath}</p> : null}
        {errors.folderPath ? (
          <p className="field-error" role="alert">
            {errors.folderPath.message}
          </p>
        ) : null}
        <Field label="Name" error={errors.name?.message} {...register('name')} />
        {errors.root ? (
          <p className="form-error" role="alert">
            {errors.root.message}
          </p>
        ) : null}
        <Button disabled={isSubmitting || !folderPath}>{isSubmitting ? 'Adding…' : 'Add project'}</Button>
      </form>
    </Card>
  );
}
