// Löyly public booking surface used to confirm a blind-agent REQUEST answer.

function bookingFormAction(html: string): string | null {
  const attribute = (tag: string, name: string) =>
    new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag)?.[1];
  const forms = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].filter(
    ([, tag, body]) =>
      attribute(tag!, 'method')?.toLowerCase() === 'post' &&
      ['household', 'resource', 'weekday', 'start'].every((name) =>
        new RegExp(`<(?:input|select)\\b[^>]*\\bname\\s*=\\s*["']${name}["']`, 'i').test(body!),
      ),
  );
  if (forms.length > 1) throw new Error('expected at most one public booking form');
  if (!forms.length) return null;
  const path = attribute(forms[0]![1]!, 'action');
  if (!/^\/[A-Za-z0-9/?=&%._-]*$/.test(path ?? '') || path!.startsWith('//'))
    throw new Error('booking form action must be a same-origin path');
  return path!;
}

async function publicJsonBooking(
  base: string,
  body: string,
  answer: string,
): Promise<{ path: string; body: string; contentType: string }> {
  const params = new URLSearchParams(body);
  const room = /^@room:(\d+)$/.exec(params.get('resource') ?? '')?.[1];
  if (!room || !new RegExp(`^REQUEST:\\s*pukuhuone\\s+${room}\\s*\\|`, 'i').test(answer))
    throw new Error('blind answer and requested room differ');
  const housesResponse = await fetch(`${base}/api/houses`, {
    signal: AbortSignal.timeout(1000),
  });
  if (!housesResponse.ok) throw new Error('no public booking form or house API');
  const houseListing = (await housesResponse.json()) as unknown[] | { houses?: unknown[] };
  const houses = Array.isArray(houseListing) ? houseListing : houseListing.houses;
  if (!Array.isArray(houses)) throw new Error('public house API has no houses');
  const matches: {
    house: string;
    resource: string;
    role: string | undefined;
    path: string;
    modernRoles: boolean;
  }[] = [];
  for (const house of houses as {
    id?: string;
    policy?: {
      resources?: { name?: string; id: string }[];
      route?: string;
      bookingMode?: string;
      eligibleRoles?: string[];
      bookerRoles?: string[];
    };
  }[]) {
    if (typeof house.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(house.id)) continue;
    let policy = house.policy;
    let resources = policy?.resources;
    let route = policy?.route ?? policy?.bookingMode;
    const modernRoles = typeof policy?.bookingMode === 'string';
    const houseScoped = Array.isArray(houseListing) || modernRoles;
    let path = houseScoped ? `/api/houses/${house.id}/bookings` : '/api/bookings';
    if (!Array.isArray(resources)) {
      const stateResponse = await fetch(`${base}/api/houses/${house.id}/state`, {
        signal: AbortSignal.timeout(1000),
      });
      if (!stateResponse.ok) continue;
      const state = (await stateResponse.json()) as {
        policy?: typeof policy;
        resources?: typeof resources;
        route?: { kind?: string };
      };
      policy = state.policy;
      resources = state.resources;
      route = state.route?.kind;
      path = `/api/houses/${house.id}/bookings`;
    }
    const named =
      resources?.filter(
        (resource) => resource.name?.trim().toLowerCase() === `pukuhuone ${room}`,
      ) ?? [];
    if (route === 'self-service' && named.length === 1)
      matches.push({
        house: house.id,
        resource: named[0]!.id,
        role: policy?.eligibleRoles?.[0] ?? policy?.bookerRoles?.[0],
        path,
        modernRoles,
      });
  }
  if (matches.length !== 1)
    throw new Error('blind room is not unique in the public self-service API');
  const match = matches[0]!;
  const payload = {
    house: match.house,
    household: params.get('household'),
    resource: match.resource,
    weekday: params.get('weekday'),
    start: params.get('start'),
    kind: 'standing',
    ...(match.modernRoles
      ? { bookerRole: match.role, actorRole: match.role }
      : { role: match.role }),
  };
  if (!Object.values(payload).every((value) => typeof value === 'string' && value.trim()))
    throw new Error('public booking request is incomplete');
  return {
    path: match.path,
    body: JSON.stringify(payload),
    contentType: 'application/json',
  };
}

function resolveRoomInPublicForm(html: string, body: string, answer: string): string {
  const params = new URLSearchParams(body);
  const token = /^@room:(\d+)$/.exec(params.get('resource') ?? '');
  if (!token) return body;
  if (!new RegExp(`^REQUEST:\\s*pukuhuone\\s+${token[1]}\\s*\\|`, 'i').test(answer))
    throw new Error('blind answer and requested room differ');
  const select = /<select\b[^>]*\bname\s*=\s*["']resource["'][^>]*>([\s\S]*?)<\/select>/i.exec(
    html,
  );
  if (!select) throw new Error('public booking form has no resource selection');
  const options = [
    ...select[1]!.matchAll(
      /<option\b[^>]*\bvalue\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/option>/gi,
    ),
  ];
  const matching = options.filter(
    ([, , label]) =>
      label!
        .replace(/<[^>]+>/g, '')
        .trim()
        .toLowerCase() === `pukuhuone ${token[1]}`,
  );
  if (matching.length !== 1) throw new Error('blind room is not a unique public form option');
  params.set('resource', matching[0]![1]!);
  return params.toString();
}

export { bookingFormAction, publicJsonBooking, resolveRoomInPublicForm };
