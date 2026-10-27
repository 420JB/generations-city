import { useEffect, useState } from 'react'
import type { DesignAccess, DesignLoad } from './design'

/**
 * A property's design as the server answers it for this viewer, read once for the whole property panel (its controller
 * status, its action bar and its design card: P1-E6). Null while it is read. Keyed by the caller per property.
 */
export function useDesignAnswer(access: DesignAccess | null, propertyId: string): DesignLoad | null {
  const [answer, setAnswer] = useState<DesignLoad | null>(null)
  useEffect(() => {
    if (!access) return
    let live = true
    void access.load(propertyId).then((r) => live && setAnswer(r))
    return () => {
      live = false
    }
  }, [access, propertyId])
  return answer
}

/** Whether the viewer may open the Architect design view for this answer: only the named controller, where design is open. */
export const designEditable = (answer: DesignLoad | null) => !!answer?.ok && answer.view.open && answer.view.control === 'viewer'
