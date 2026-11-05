-- Facebook Messenger and Instagram Direct as inbox channels, both through the
-- CosmoBots Meta app (pilot, item 01). Additive enum values.
ALTER TYPE "ChannelType" ADD VALUE IF NOT EXISTS 'FACEBOOK';
ALTER TYPE "ChannelType" ADD VALUE IF NOT EXISTS 'INSTAGRAM';
