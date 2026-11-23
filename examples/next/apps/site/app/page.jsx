import { price } from 'format'

export default function Page() {
  return <h1>Coffee {price(350)}</h1>
}
