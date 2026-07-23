import type {
  CalendarProvider,
  ListCalendarEventsInput,
  ProviderContext,
  UpsertCalendarEventInput,
} from "../../../../src/mail/types";

import {
  CalendarRepositoryError,
  deleteStoredCalendarEvent,
  listStoredCalendarEvents,
  listStoredCalendars,
  upsertStoredCalendarEvent,
} from "./calendar-repository";

export class LocalCalendarProvider implements CalendarProvider {
  async listCalendars(_context: ProviderContext) {
    return listStoredCalendars();
  }

  async listEvents(_context: ProviderContext, input: ListCalendarEventsInput) {
    const items = await listStoredCalendarEvents(input);
    return { items };
  }

  async upsertEvent(_context: ProviderContext, input: UpsertCalendarEventInput) {
    return upsertStoredCalendarEvent(input);
  }

  async deleteEvent(_context: ProviderContext, calendarId: string, eventId: string) {
    if (!await deleteStoredCalendarEvent(calendarId, eventId)) {
      throw new CalendarRepositoryError("EVENT_NOT_FOUND", "日程不存在", 404);
    }
  }
}

export const localCalendarProvider = new LocalCalendarProvider();

export const localCalendarContext: ProviderContext = {
  account: {
    id: "local-calendar-account",
    providerId: "local-calendar",
    emailAddress: "local-calendar@device.invalid",
    displayName: "本地日历",
    enabled: true,
  },
  session: { kind: "basic", username: "local-calendar", password: "local-only" },
};
