# Asaas tokenized checkout migration plan

The legacy `/planos/assinar` endpoint is disabled by default in production. It must remain disabled until PAN/CVV no longer cross Prognexo infrastructure.

Preferred migration: Asaas hosted checkout. The browser is redirected to an Asaas-hosted payment page and Prognexo receives only opaque checkout/subscription identifiers through a signed webhook. If hosted checkout cannot support the product, tokenize card data directly in the browser using an Asaas-supported client component; the API receives only a single-use token.

Before enabling: confirm the official Asaas flow and PCI scope, introduce a provisioning state machine and idempotency key, validate signed payment webhooks, correlate checkout to a pending account server-side, add failure compensation, remove card fields from API/frontend, rotate credentials, and test retries/failures using synthetic sandbox data. No paid integration or production change is part of FASE 1A.
