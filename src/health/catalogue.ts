/**
 * Every check, in tree order: groups in `CHECK_GROUPS` order, and within a
 * group the PRD FR-5.6 order. The tree renders this list directly, so the order
 * here is the order the user reads — dependencies first, so a fresh install
 * reads top-down as a story rather than a pile of failures.
 */

import { configBedrockCheck } from "./checks/config.bedrock.js";
import { configDriftCheck } from "./checks/config.drift.js";
import { configExistsCheck } from "./checks/config.exists.js";
import { configModelsCheck } from "./checks/config.models.js";
import { configParsesCheck } from "./checks/config.parses.js";
import { configPermsCheck } from "./checks/config.perms.js";
import { configRegionCheck } from "./checks/config.region.js";
import { credAgeCheck } from "./checks/cred.age.js";
import { credLeakCheck } from "./checks/cred.leak.js";
import { credMirroredCheck } from "./checks/cred.mirrored.js";
import { credPresentCheck } from "./checks/cred.present.js";
import { credValidCheck } from "./checks/cred.valid.js";
import { installCliCheck } from "./checks/install.cli.js";
import { installExtensionCheck } from "./checks/install.extension.js";
import { installVersionCheck } from "./checks/install.version.js";
import { configStaleCheck } from "./checks/placeholders.js";
import { pluginsEnabledCheck } from "./checks/plugins.enabled.js";
import { pluginsMarketplaceCheck } from "./checks/plugins.marketplace.js";
import type { Check } from "./types.js";

export const ALL_CHECKS: readonly Check[] = [
  installExtensionCheck,
  installVersionCheck,
  installCliCheck,
  configExistsCheck,
  configParsesCheck,
  configPermsCheck,
  configBedrockCheck,
  configRegionCheck,
  configModelsCheck,
  configDriftCheck,
  configStaleCheck,
  credPresentCheck,
  credMirroredCheck,
  credValidCheck,
  credAgeCheck,
  credLeakCheck,
  pluginsMarketplaceCheck,
  pluginsEnabledCheck,
];
