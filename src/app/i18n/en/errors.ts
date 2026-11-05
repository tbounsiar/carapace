// Backend error texts, keyed `errors.<area>.<name>` as the backend sends them.
import analytics from './errors/analytics.json';
import config from './errors/config.json';
import dataTransfer from './errors/data-transfer.json';
import external from './errors/external.json';
import files from './errors/files.json';
import keys from './errors/keys.json';
import local from './errors/local.json';
import secrets from './errors/secrets.json';
import settings from './errors/settings.json';
import ssh from './errors/ssh.json';
import terminal from './errors/terminal.json';
import transfer from './errors/transfer.json';

export default {
  analytics,
  config,
  dataTransfer,
  external,
  files,
  keys,
  local,
  secrets,
  settings,
  ssh,
  terminal,
  transfer,
};
