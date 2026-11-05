import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { detectLanguage, HIGHLIGHT_LIMIT, initialLanguage, languageLabel } from './language';

describe('detectLanguage', () => {
  // The helpers translate through Transloco's global service, created on first injection.
  beforeEach(() => TestBed.inject(TranslocoService));

  it.each([
    ['/srv/app/Dockerfile', 'dockerfile'],
    ['/srv/app/Containerfile', 'dockerfile'],
    ['/srv/Dockerfile.prod', 'dockerfile'],
    ['/srv/api.dockerfile', 'dockerfile'],
    ['/srv/package.json', 'json'],
    ['/srv/docker-compose.yml', 'yaml'],
    ['/srv/ci.YAML', 'yaml'],
    ['/opt/run.sh', 'shell'],
    ['/home/me/.bashrc', 'shell'],
    ['/home/me/.zprofile', 'shell'],
    ['/etc/nginx/nginx.conf', 'nginx'],
    ['/etc/nginx/sites-available/default', 'nginx'],
    ['/etc/nginx/conf.d/app.conf', 'nginx'],
    ['/etc/mysql/my.cnf', 'ini'],
    ['/etc/app.conf', 'ini'],
    ['/srv/app.properties', 'ini'],
    ['/srv/.env', 'ini'],
    ['/srv/.env.local', 'ini'],
    ['/srv/app.env', 'ini'],
    ['/etc/systemd/system/app.service', 'ini'],
    ['/etc/systemd/system/backup.timer', 'ini'],
    ['/usr/local/bin/run', 'plain'],
    ['/etc/nginx/mime.types', 'plain'],
    ['/var/log/syslog', 'plain'],
  ])('%s is %s', (path, language) => {
    expect(detectLanguage(path)).toBe(language);
  });

  it('opens files over the highlighting limit as plain text', () => {
    expect(initialLanguage('/etc/nginx/nginx.conf', HIGHLIGHT_LIMIT)).toBe('nginx');
    expect(initialLanguage('/etc/nginx/nginx.conf', HIGHLIGHT_LIMIT + 1)).toBe('plain');
  });

  it('names the languages', () => {
    expect(languageLabel('ini')).toBe('INI / properties');
    expect(languageLabel('plain')).toBe('Plain text');
  });
});
