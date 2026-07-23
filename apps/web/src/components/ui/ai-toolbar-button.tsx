'use client';

import * as React from 'react';

import { ToolbarButton } from './toolbar';

export function AIToolbarButton(
  props: React.ComponentProps<typeof ToolbarButton>
) {
  return (
    <ToolbarButton
      {...props}
      disabled
      tooltip="AI 将在后续阶段接入"
    />
  );
}
