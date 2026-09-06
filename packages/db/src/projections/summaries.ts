import type { SummaryGeneratedV1 } from "@finch/core";

export interface SummaryContent {
  readonly periodType: string;
  readonly period: string;
  readonly contentHash: string;
}

export interface SummaryContentKey {
  readonly periodType: string;
  readonly period: string;
  readonly content: SummaryContent;
  readonly contentJson: string;
}

export const summaryContentKey = (payload: SummaryGeneratedV1): SummaryContentKey => {
  const content: SummaryContent = {
    periodType: payload.periodType,
    period: payload.period,
    contentHash: payload.contentHash,
  };
  return {
    periodType: payload.periodType,
    period: payload.period,
    content,
    contentJson: JSON.stringify(content),
  };
};
