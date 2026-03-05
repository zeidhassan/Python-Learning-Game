import axios from 'axios'

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000/api',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
})

export function getApiError(error, fallback = 'Request failed') {
  const fieldErrors = error?.response?.data?.details?.fieldErrors
  if (fieldErrors && typeof fieldErrors === 'object') {
    const firstField = Object.values(fieldErrors).find((value) => Array.isArray(value) && value.length)
    if (firstField) {
      return firstField[0]
    }
  }

  const formErrors = error?.response?.data?.details?.formErrors
  if (Array.isArray(formErrors) && formErrors.length) {
    return formErrors[0]
  }

  if (error?.code === 'ERR_NETWORK' || !error?.response) {
    return 'Network error. Check that the server is running and your connection is available.'
  }

  return (
    error?.response?.data?.message ||
    error?.response?.data?.error ||
    error?.message ||
    fallback
  )
}
