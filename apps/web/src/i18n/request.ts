import { getRequestConfig } from 'next-intl/server'

import { MESSAGES } from './config'
import { getLocale } from './get-locale'

export default getRequestConfig(async () => {
  const locale = await getLocale()
  return {
    locale,
    messages: MESSAGES[locale],
  }
})
