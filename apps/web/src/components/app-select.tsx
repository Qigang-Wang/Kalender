"use client";

import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import type { ReactNode } from "react";

const EMPTY_VALUE = "__qgw_empty_select_value__";

export interface AppSelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export function AppSelect({
  value,
  options,
  onValueChange,
  ariaLabel,
  disabled = false,
  placeholder = "请选择",
  size = "default",
  variant = "default",
  className = "",
  leading,
}: {
  readonly value: string;
  readonly options: readonly AppSelectOption[];
  readonly onValueChange: (value: string) => void;
  readonly ariaLabel: string;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly size?: "compact" | "default";
  readonly variant?: "default" | "ghost";
  readonly className?: string;
  readonly leading?: ReactNode;
}) {
  const selectedValue = value === "" ? EMPTY_VALUE : value;
  return (
    <SelectPrimitive.Root
      value={selectedValue}
      disabled={disabled}
      onValueChange={(nextValue) => onValueChange(nextValue === EMPTY_VALUE ? "" : nextValue)}
    >
      <SelectPrimitive.Trigger
        className={`app-select-trigger ${size === "compact" ? "compact" : ""} ${variant === "ghost" ? "ghost" : ""} ${className}`.trim()}
        aria-label={ariaLabel}
      >
        {leading && <span className="app-select-leading">{leading}</span>}
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon asChild><ChevronDown size={15} /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          className="app-select-content"
          position="popper"
          sideOffset={5}
          align="start"
          collisionPadding={8}
        >
          <SelectPrimitive.ScrollUpButton className="app-select-scroll-button">
            <ChevronUp size={14} />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="app-select-viewport">
            {options.map((option) => (
              <SelectPrimitive.Item
                className="app-select-item"
                disabled={option.disabled}
                key={option.value}
                value={option.value === "" ? EMPTY_VALUE : option.value}
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="app-select-indicator">
                  <Check size={14} strokeWidth={2.2} />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="app-select-scroll-button">
            <ChevronDown size={14} />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
