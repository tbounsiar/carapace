import { Routes } from '@angular/router';

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
  { path: '**', redirectTo: '' },
];
