// The Releases' feed.
import type { APIRoute } from 'astro'
import { feed } from '../../blog/feed.js'

export const GET: APIRoute = ({ site }) => feed('releases', site)
