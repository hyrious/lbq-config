import { RegisterFunction } from '../lib/base'

export default function install(register: RegisterFunction) {
	register('hello', () => console.log('world'))
}
