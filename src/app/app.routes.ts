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
    path: 'projects/:projectId/variables',
    loadComponent: variablesPage,
    canDeactivate: [unsavedChangesGuard],
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
  { path: '**', redirectTo: '' },
];
