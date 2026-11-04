import { Routes } from '@angular/router';
import { unsavedChangesGuard } from './features/variables/unsaved-changes-guard';

const variablesPage = () =>
  import('./features/variables/variables-page/variables-page').then((m) => m.VariablesPage);

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./features/welcome/welcome/welcome').then((m) => m.Welcome),
  },
  {
    path: 'hosts/:hostId',
    loadComponent: () =>
      import('./features/host-detail/host-detail/host-detail').then((m) => m.HostDetail),
  },
  {
    path: 'tabs/:tabId',
    loadComponent: () => import('./features/workspace/tab-page/tab-page').then((m) => m.TabPage),
  },
  {
    path: 'projects/:projectId',
    loadComponent: () =>
      import('./features/project-home/project-home/project-home').then((m) => m.ProjectHome),
    children: [
      {
        path: '',
        loadComponent: () =>
          import('./features/project-home/project-hosts/project-hosts').then((m) => m.ProjectHosts),
      },
      {
        path: 'variables',
        loadComponent: variablesPage,
        canDeactivate: [unsavedChangesGuard],
        data: { embedded: true },
      },
    ],
  },
  { path: 'variables', loadComponent: variablesPage, canDeactivate: [unsavedChangesGuard] },
  {
    path: 'keys',
    loadComponent: () => import('./features/keys/keys-page/keys-page').then((m) => m.KeysPage),
  },
  {
    path: 'settings',
    loadComponent: () =>
      import('./features/settings/settings-page/settings-page').then((m) => m.SettingsPage),
  },
  {
    path: 'edited-files',
    loadComponent: () =>
      import('./features/external-editor/edited-files-page/edited-files-page').then(
        (m) => m.EditedFilesPage,
      ),
  },
  { path: '**', redirectTo: '' },
];
