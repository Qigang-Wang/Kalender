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
      tooltip="KI wird zu einem späteren Zeitpunkt abgerufen"
    />
  );
}
