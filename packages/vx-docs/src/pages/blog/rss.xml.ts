// The blog's feed, at the URL starlight-blog served it from.
import type { APIRoute } from 'astro'
import { feed } from '../../blog/feed.js'

export const GET: APIRoute = ({ site }) => feed('blog', site)
