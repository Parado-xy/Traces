/**
 * Shared provider configuration and redacted setup diagnostics.
 * Secrets remain in server-side memory. Readiness means settings are present;
 * it never claims that a token works or that a provider approved the use case.
 */
import type { EbayConfig } from '../adapters/ebay.ts';

/** Credentials and explicit operator confirmations consumed by integration commands. */
export type IntegrationConfig = {
  ebay: EbayConfig;
  bikeIndexToken: string;
  bikeIndexNotifyApproved: boolean;
};

/** Reads one environment consistently for the CLI and live-test runner. */
export function integrationConfig(
  environment: NodeJS.ProcessEnv = process.env,
): IntegrationConfig {
  const ebayEnvironment = environment.EBAY_ENV || 'sandbox';
  if (ebayEnvironment !== 'sandbox' && ebayEnvironment !== 'production') {
    throw new Error('EBAY_ENV must be sandbox or production');
  }
  return {
    ebay: {
      clientId: environment.EBAY_CLIENT_ID || '',
      clientSecret: environment.EBAY_CLIENT_SECRET || '',
      environment: ebayEnvironment,
      productionApproved: environment.EBAY_PRODUCTION_APPROVED === 'true',
    },
    bikeIndexToken: environment.BIKEINDEX_TOKEN || '',
    bikeIndexNotifyApproved: environment.BIKEINDEX_NOTIFY_APPROVED === 'true',
  };
}

/**
 * Returns presence flags and next steps without exposing any key or token values.
 * Provider permission and a successful HTTP request are separate from configuration.
 */
export function integrationStatus(config: IntegrationConfig) {
  const ebayMissing = [
    !config.ebay.clientId ? 'EBAY_CLIENT_ID' : null,
    !config.ebay.clientSecret ? 'EBAY_CLIENT_SECRET' : null,
    config.ebay.environment === 'production' && !config.ebay.productionApproved
      ? 'EBAY_PRODUCTION_APPROVED (provider access and application purpose confirmed)'
      : null,
  ].filter(Boolean);
  return {
    checkedAt: new Date().toISOString(),
    bikeIndex: {
      publicReadsRequireToken: false,
      tokenConfigured: Boolean(config.bikeIndexToken),
      notificationSetupConfirmed: config.bikeIndexNotifyApproved,
      notificationDelivery: 'not_checked',
      next: 'Read test works without a token. Owner notification needs a scoped token and controlled authorized case.',
    },
    ebay: {
      environment: config.ebay.environment,
      clientIdConfigured: Boolean(config.ebay.clientId),
      clientSecretConfigured: Boolean(config.ebay.clientSecret),
      productionPurposeConfirmed: config.ebay.productionApproved,
      readyToAttemptSearch: ebayMissing.length === 0,
      missing: ebayMissing,
      next:
        config.ebay.environment === 'sandbox'
          ? 'Use synthetic case attributes and known sandbox inventory; zero results is not a recovery test.'
          : 'Confirm provider access and the recovery use case before a bounded search on a real open case.',
    },
    limitation:
      'This is a configuration check, not a token, provider-approval or field-performance validation.',
  };
}
