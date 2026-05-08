interface RouteGuardProps {
  children: React.ReactNode
}

function RouteGuard({ children }: RouteGuardProps) {
  return <>{children}</>
}

export default RouteGuard
